import { NextRequest, NextResponse } from 'next/server';
import { getDatabase, Agent, db_helpers } from '@/lib/db';
import { eventBus } from '@/lib/event-bus';
import { getTemplate, buildAgentConfig } from '@/lib/agent-templates';
import { writeAgentToConfig, enrichAgentConfigFromWorkspace } from '@/lib/agent-sync';
import { logAuditEvent } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { mutationLimiter } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { validateBody, createAgentSchema, toOpenClawKebabId } from '@/lib/validation';
import { runOpenClaw } from '@/lib/command';
import { config as appConfig } from '@/lib/config';
import { resolveWithin } from '@/lib/paths';
import { syncRuntimeAgents } from '@/lib/runtime-agent-sync';
import path from 'node:path';
import { validateAgentSessionKindBinding } from '@/lib/agent-session-binding';
import { resolveSessionKindForBinding } from '@/lib/infer-local-session-kind';
import {
  enqueueProvisionAgentDedicatedSession,
  shouldAutoProvisionSessionOnCreate,
} from '@/lib/local-session-executor';

function parseAgentConfigRecord(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {}
    } catch {
      return {}
    }
  }
  return typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/**
 * GET /api/agents - List all agents with optional filtering
 * Query params: status, role, limit, offset
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const db = getDatabase();
    const { searchParams } = new URL(request.url);
    const workspaceId = auth.user.workspace_id ?? 1;
    
    // Parse query parameters
    const status = searchParams.get('status');
    const role = searchParams.get('role');
    const showHidden = searchParams.get('show_hidden') === 'true';
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 200);
    const offset = parseInt(searchParams.get('offset') || '0');

    // Build dynamic query
    let query = 'SELECT * FROM agents WHERE workspace_id = ?';
    const params: any[] = [workspaceId];

    if (!showHidden) {
      query += ' AND hidden = 0';
    }
    
    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }
    
    if (role) {
      query += ' AND role = ?';
      params.push(role);
    }
    
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    
    const stmt = db.prepare(query);
    const agents = stmt.all(...params) as Agent[];
    
    // Parse JSON config field
    const agentsWithParsedData = agents.map(agent => ({
      ...agent,
      config: enrichAgentConfigFromWorkspace(agent.config ? JSON.parse(agent.config) : {})
    }));
    
    // Get task counts for all listed agents in one query (avoids N+1 queries)
    const aliasesByAgent = new Map(agentsWithParsedData.map((agent) => {
      const parsedConfig = parseAgentConfigRecord(agent.config)
      const aliases = [...new Set([
        agent.name,
        typeof parsedConfig.original_name === 'string' ? parsedConfig.original_name : '',
        agent.session_key || '',
      ].map((value) => String(value || '').trim()).filter(Boolean))]
      return [agent.name, aliases] as const
    }))
    const agentNames = [...new Set([...aliasesByAgent.values()].flat())]
    const taskStatsByAgent = new Map<string, { total: number; assigned: number; in_progress: number; quality_review: number; done: number }>()

    if (agentNames.length > 0) {
      const placeholders = agentNames.map(() => '?').join(', ')
      const groupedTaskStats = db.prepare(`
        SELECT
          assigned_to,
          COUNT(*) as total,
          SUM(CASE WHEN status = 'assigned' THEN 1 ELSE 0 END) as assigned,
          SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
          SUM(CASE WHEN status = 'quality_review' THEN 1 ELSE 0 END) as quality_review,
          SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done
        FROM tasks
        WHERE workspace_id = ? AND assigned_to IN (${placeholders})
        GROUP BY assigned_to
      `).all(workspaceId, ...agentNames) as Array<{
        assigned_to: string
        total: number | null
        assigned: number | null
        in_progress: number | null
        quality_review: number | null
        done: number | null
      }>

      for (const row of groupedTaskStats) {
        taskStatsByAgent.set(row.assigned_to, {
          total: row.total || 0,
          assigned: row.assigned || 0,
          in_progress: row.in_progress || 0,
          quality_review: row.quality_review || 0,
          done: row.done || 0,
        })
      }
    }

    const agentsWithStats = agentsWithParsedData.map(agent => {
      const taskStats = (aliasesByAgent.get(agent.name) || []).reduce((total, alias) => {
        const stats = taskStatsByAgent.get(alias)
        if (!stats) return total
        total.total += stats.total
        total.assigned += stats.assigned
        total.in_progress += stats.in_progress
        total.quality_review += stats.quality_review
        total.done += stats.done
        return total
      }, {
        total: 0,
        assigned: 0,
        in_progress: 0,
        quality_review: 0,
        done: 0,
      })

      return {
        ...agent,
        taskStats: {
          ...taskStats,
          completed: taskStats.done,
        }
      };
    });
    
    // Get total count for pagination
    let countQuery = 'SELECT COUNT(*) as total FROM agents WHERE workspace_id = ?';
    const countParams: any[] = [workspaceId];
    if (!showHidden) {
      countQuery += ' AND hidden = 0';
    }
    if (status) {
      countQuery += ' AND status = ?';
      countParams.push(status);
    }
    if (role) {
      countQuery += ' AND role = ?';
      countParams.push(role);
    }
    const countRow = db.prepare(countQuery).get(...countParams) as { total: number };

    return NextResponse.json({
      agents: agentsWithStats,
      total: countRow.total,
      page: Math.floor(offset / limit) + 1,
      limit
    });
  } catch (error) {
    logger.error({ err: error }, 'GET /api/agents error');
    return NextResponse.json({ error: 'Failed to fetch agents' }, { status: 500 });
  }
}

/**
 * POST /api/agents - Create a new agent
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const rateCheck = mutationLimiter(request);
  if (rateCheck) return rateCheck;

  try {
    const db = getDatabase();
    const workspaceId = auth.user.workspace_id ?? 1;
    const validated = await validateBody(request, createAgentSchema);
    if ('error' in validated) return validated.error;
    const body = validated.data;

    const {
      name,
      openclaw_id,
      role,
      session_key,
      soul_content,
      status = 'offline',
      config = {},
      template,
      gateway_config,
      write_to_gateway,
      provision_openclaw_workspace,
      openclaw_workspace_path,
      workspace_path,
      framework = 'openclaw',
      parent_id
    } = body;

    const openclawId = toOpenClawKebabId(openclaw_id || name, name || 'agent');

    // Resolve template if specified
    let finalRole = role;
    let finalConfig: Record<string, any> = { ...config };
    if (template) {
      const tpl = getTemplate(template);
      if (tpl) {
        const builtConfig = buildAgentConfig(tpl, (gateway_config || {}) as any);
        finalConfig = { ...builtConfig, ...finalConfig };
        if (!finalRole) finalRole = tpl.config.identity?.theme || tpl.type;
      }
    } else if (gateway_config) {
      finalConfig = { ...finalConfig, ...(gateway_config as Record<string, any>) };
    }
    finalConfig.main_runtime = framework
    if (framework && framework !== 'openclaw' && finalConfig.runtime_managed !== true) {
      finalConfig.session_mode = finalConfig.session_mode || 'dedicated'
      finalConfig.session_strategy = finalConfig.session_strategy || 'persistent'
      finalConfig.session_state = session_key ? 'ready' : 'provisioning'
      finalConfig.primary_session_key = session_key || finalConfig.primary_session_key || null
      finalConfig.session_bootstrap_state = session_key ? 'ready' : 'provisioning'
      finalConfig.session_bootstrap_hash = null
      finalConfig.session_bootstrap_error = null
    }

    if (!name || !finalRole) {
      return NextResponse.json({ error: 'Name and role are required' }, { status: 400 });
    }

    // Check if agent name already exists
    const existingAgent = db
      .prepare('SELECT id FROM agents WHERE name = ? AND workspace_id = ?')
      .get(name, workspaceId);
    if (existingAgent) {
      return NextResponse.json({ error: 'Agent name already exists' }, { status: 409 });
    }

    if (provision_openclaw_workspace && framework === 'openclaw') {
      if (!appConfig.openclawStateDir) {
        return NextResponse.json(
          { error: 'OPENCLAW_STATE_DIR is not configured; cannot provision OpenClaw workspace' },
          { status: 500 }
        );
      }

      const workspacePath = openclaw_workspace_path
        ? path.resolve(openclaw_workspace_path)
        : resolveWithin(appConfig.openclawStateDir, path.join('workspaces', openclawId));

      try {
        await runOpenClaw(
          ['agents', 'add', openclawId, '--workspace', workspacePath, '--non-interactive'],
          { timeoutMs: 20000 }
        );
      } catch (provisionError: any) {
        logger.error({ err: provisionError, openclawId, workspacePath }, 'OpenClaw workspace provisioning failed');
        return NextResponse.json(
          { error: provisionError?.message || 'Failed to provision OpenClaw agent workspace' },
          { status: 502 }
        );
      }
    }

    let resolvedParentId = parent_id ?? undefined
    if (!resolvedParentId && framework) {
      try {
        await syncRuntimeAgents(auth.user.username)
        const runtimeParent = db.prepare(`
          SELECT id
          FROM agents
          WHERE workspace_id = ? AND source = 'runtime' AND framework = ? AND hidden = 0
          LIMIT 1
        `).get(workspaceId, framework) as { id: number } | undefined
        if (runtimeParent?.id) {
          resolvedParentId = runtimeParent.id
        }
      } catch (runtimeSyncError) {
        logger.warn({ err: runtimeSyncError, framework }, 'Runtime parent auto-link failed')
      }
    }
    
    const now = Math.floor(Date.now() / 1000);
    
    const resolvedWorkspacePath = workspace_path?.trim()
      ? path.resolve(workspace_path.trim())
      : null

    const stmt = db.prepare(`
      INSERT INTO agents (
        name, role, session_key, soul_content, status, 
        created_at, updated_at, config, workspace_id, framework, parent_id, workspace_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const dbResult = stmt.run(
      name,
      finalRole,
      session_key,
      soul_content,
      status,
      now,
      now,
      JSON.stringify(finalConfig),
      workspaceId,
      framework,
      resolvedParentId,
      resolvedWorkspacePath
    );

    const agentId = dbResult.lastInsertRowid as number;
    
    // Log activity
    db_helpers.logActivity(
      'agent_created',
      'agent',
      agentId,
      auth.user.username,
      `Created agent: ${name} (${finalRole})${template ? ` from template: ${template}` : ''}`,
      {
        name,
        role: finalRole,
        status,
        session_key,
        template: template || null
      },
      workspaceId
    );
    
    // Fetch the created agent
    const createdAgent = db
      .prepare('SELECT * FROM agents WHERE id = ? AND workspace_id = ?')
      .get(agentId, workspaceId) as Agent;
    const parsedAgent = {
      ...createdAgent,
      config: JSON.parse(createdAgent.config || '{}'),
      taskStats: { total: 0, assigned: 0, in_progress: 0, quality_review: 0, done: 0, completed: 0 }
    };

    // Broadcast to SSE clients
    eventBus.broadcast('agent.created', parsedAgent);

    let sessionProvisioning = false
    if (shouldAutoProvisionSessionOnCreate(parsedAgent)) {
      sessionProvisioning = true
      enqueueProvisionAgentDedicatedSession({
        id: agentId,
        name: parsedAgent.name,
        framework: parsedAgent.framework,
        workspace_path: parsedAgent.workspace_path,
        config: parsedAgent.config,
        session_key: parsedAgent.session_key,
      })
    }

    // Write to gateway config if requested
    if (write_to_gateway && finalConfig) {
      try {
        await writeAgentToConfig({
          id: openclawId,
          name,
          ...(finalConfig.model && { model: finalConfig.model }),
          ...(finalConfig.identity && { identity: finalConfig.identity }),
          ...(finalConfig.sandbox && { sandbox: finalConfig.sandbox }),
          ...(finalConfig.tools && { tools: finalConfig.tools }),
          ...(finalConfig.subagents && { subagents: finalConfig.subagents }),
          ...(finalConfig.memorySearch && { memorySearch: finalConfig.memorySearch }),
        });

        const ipAddress = request.headers.get('x-forwarded-for') || 'unknown';
        logAuditEvent({
          action: 'agent_gateway_create',
          actor: auth.user.username,
          actor_id: auth.user.id,
          target_type: 'agent',
          target_id: agentId as number,
          detail: { name, openclaw_id: openclawId, template: template || null },
          ip_address: ipAddress,
        });
      } catch (gwErr: any) {
        logger.error({ err: gwErr }, 'Gateway write-back failed');
        return NextResponse.json({ 
          agent: parsedAgent,
          warning: `Agent created in MC but gateway write failed: ${gwErr.message}`
        }, { status: 201 });
      }
    }

    return NextResponse.json({
      agent: parsedAgent,
      session_provisioning: sessionProvisioning,
    }, { status: 201 });
  } catch (error) {
    logger.error({ err: error }, 'POST /api/agents error');
    return NextResponse.json({ error: 'Failed to create agent' }, { status: 500 });
  }
}

/**
 * PUT /api/agents - Update agent status (bulk operation for status updates)
 */
export async function PUT(request: NextRequest) {
  const auth = requireRole(request, 'operator');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const rateCheck = mutationLimiter(request);
  if (rateCheck) return rateCheck;

  try {
    const db = getDatabase();
    const workspaceId = auth.user.workspace_id ?? 1;
    const body = await request.json();

    // Handle single agent update or bulk updates
    if (body.name) {
      // Single agent update
      const { name, status, last_activity, config, session_key, session_kind, soul_content, role, workspace_path } = body;
      
      const agent = db
        .prepare('SELECT * FROM agents WHERE name = ? AND workspace_id = ?')
        .get(name, workspaceId) as Agent;
      if (!agent) {
        return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
      }
      
      const now = Math.floor(Date.now() / 1000);
      
      // Build dynamic update query
      const fieldsToUpdate = [];
      const params: any[] = [];
      
      if (status !== undefined) {
        fieldsToUpdate.push('status = ?');
        params.push(status);
        
        fieldsToUpdate.push('last_seen = ?');
        params.push(now);
      }
      
      if (last_activity !== undefined) {
        fieldsToUpdate.push('last_activity = ?');
        params.push(last_activity);
      }
      
      if (config !== undefined) {
        fieldsToUpdate.push('config = ?');
        params.push(JSON.stringify(config));
      }
      
      if (session_key !== undefined) {
        const trimmedSessionKey = String(session_key || '').trim()
        if (trimmedSessionKey) {
          const resolvedSessionKind = resolveSessionKindForBinding(trimmedSessionKey, session_kind)
          if (!resolvedSessionKind) {
            return NextResponse.json(
              { error: 'Could not determine local session type for binding. Pass session_kind explicitly.' },
              { status: 400 },
            )
          }
          const kindCheck = validateAgentSessionKindBinding(agent.framework, resolvedSessionKind)
          if (!kindCheck.ok) {
            return NextResponse.json(
              { error: kindCheck.message, code: 'session_kind_mismatch' },
              { status: 409 },
            )
          }
        }

        fieldsToUpdate.push('session_key = ?');
        params.push(session_key);

        const mergedConfig = {
          ...parseAgentConfigRecord(config !== undefined ? config : agent.config),
          primary_session_key: session_key || null,
          session_state: session_key ? 'ready' : 'pending',
          session_bootstrap_state: 'pending',
          session_bootstrap_hash: null,
          session_bootstrap_error: null,
        } as Record<string, unknown>

        if (agent.framework && agent.framework !== 'openclaw' && mergedConfig.runtime_managed !== true) {
          mergedConfig.session_mode = mergedConfig.session_mode || 'dedicated'
          mergedConfig.session_strategy = mergedConfig.session_strategy || 'persistent'
        }

        if (session_key) {
          mergedConfig.mc_bound_agent_id = agent.id
        } else {
          delete mergedConfig.mc_bound_agent_id
        }

        if (config === undefined) {
          fieldsToUpdate.push('config = ?');
          params.push(JSON.stringify(mergedConfig));
        }
      }
      
      if (soul_content !== undefined) {
        fieldsToUpdate.push('soul_content = ?');
        params.push(soul_content);
      }
      
      if (role !== undefined) {
        fieldsToUpdate.push('role = ?');
        params.push(role);
      }

      if (workspace_path !== undefined) {
        fieldsToUpdate.push('workspace_path = ?');
        params.push(
          String(workspace_path || '').trim()
            ? path.resolve(String(workspace_path).trim())
            : null,
        );
      }
      
      fieldsToUpdate.push('updated_at = ?');
      params.push(now);
      params.push(name, workspaceId);
      
      if (fieldsToUpdate.length === 1) { // Only updated_at
        return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
      }
      
      const stmt = db.prepare(`
        UPDATE agents 
        SET ${fieldsToUpdate.join(', ')}
        WHERE name = ? AND workspace_id = ?
      `);
      
      stmt.run(...params);

      const updatedAgent = db
        .prepare('SELECT * FROM agents WHERE id = ? AND workspace_id = ?')
        .get(agent.id, workspaceId) as Agent;
      const parsedUpdatedAgent = {
        ...updatedAgent,
        config: parseAgentConfigRecord(updatedAgent.config),
      };
      
      // Log status change if status was updated
      if (status !== undefined && status !== agent.status) {
        db_helpers.logActivity(
          'agent_status_change',
          'agent',
          agent.id,
          name,
          `Agent status changed from ${agent.status} to ${status}`,
          {
            oldStatus: agent.status,
            newStatus: status,
            last_activity
          },
          workspaceId
        );
      }

      // Broadcast update to SSE clients
      eventBus.broadcast('agent.updated', {
        id: agent.id,
        name,
        ...(status !== undefined && { status }),
        ...(last_activity !== undefined && { last_activity }),
        ...(role !== undefined && { role }),
        ...(workspace_path !== undefined && { workspace_path: parsedUpdatedAgent.workspace_path }),
        updated_at: now,
      });

      return NextResponse.json({ success: true, agent: parsedUpdatedAgent });
    } else {
      return NextResponse.json({ error: 'Agent name is required' }, { status: 400 });
    }
  } catch (error) {
    logger.error({ err: error }, 'PUT /api/agents error');
    return NextResponse.json({ error: 'Failed to update agent' }, { status: 500 });
  }
}
