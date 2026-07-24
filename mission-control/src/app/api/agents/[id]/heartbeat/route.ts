import { NextRequest, NextResponse } from 'next/server';
import { getDatabase, db_helpers } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { agentHeartbeatLimiter } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { resolveTaskImplementationTarget } from '@/lib/task-routing';
import { resolveAgentQueryIdentity, sqlPlaceholders } from '@/lib/agent-query-identity';

/**
 * GET /api/agents/[id]/heartbeat - Agent heartbeat check
 * 
 * Checks for:
 * - @mentions in recent comments
 * - Assigned tasks
 * - Recent activity feed items
 * 
 * Returns work items or "HEARTBEAT_OK" if nothing to do
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const db = getDatabase();
    const resolvedParams = await params;
    const agentId = resolvedParams.id;
    const workspaceId = auth.user.workspace_id ?? 1;
    
    const agent = resolveAgentQueryIdentity(db, agentId, workspaceId)
    
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }
    
    const workItems: any[] = [];
    const now = Math.floor(Date.now() / 1000);
    const fourHoursAgo = now - (4 * 60 * 60); // Check last 4 hours
    
    // 1. Check for @mentions in recent comments
    const mentions = db.prepare(`
      SELECT c.*, t.title as task_title 
      FROM comments c
      JOIN tasks t ON c.task_id = t.id
      WHERE EXISTS (
        SELECT 1 FROM json_each(COALESCE(c.mentions, '[]')) mention
        WHERE mention.value IN (${sqlPlaceholders(agent.aliases)})
      )
      AND c.workspace_id = ?
      AND t.workspace_id = ?
      AND c.created_at > ?
      ORDER BY c.created_at DESC
      LIMIT 10
    `).all(...agent.aliases, workspaceId, workspaceId, fourHoursAgo);
    
    if (mentions.length > 0) {
      workItems.push({
        type: 'mentions',
        count: mentions.length,
        items: mentions.map((m: any) => ({
          id: m.id,
          task_title: m.task_title,
          author: m.author,
          content: m.content.substring(0, 100) + '...',
          created_at: m.created_at
        }))
      });
    }
    
    // 2. Check for assigned tasks
    const assignedTasks = db.prepare(`
      SELECT DISTINCT t.* FROM tasks t
      LEFT JOIN supervision_goal_tasks sgt ON sgt.task_id = t.id
      LEFT JOIN supervision_goals g ON g.id = sgt.goal_id AND g.workspace_id = t.workspace_id
      WHERE t.workspace_id = ?
      AND (
        t.assigned_to IN (${sqlPlaceholders(agent.aliases)})
        ${agent.clientId && agent.localAgentId != null
          ? `OR (g.client_id = ? AND sgt.assigned_agent_id = ?)`
          : ''}
      )
      AND t.status IN ('assigned', 'in_progress')
      ORDER BY t.priority DESC, t.created_at ASC
      LIMIT 10
    `).all(
      workspaceId,
      ...agent.aliases,
      ...(agent.clientId && agent.localAgentId != null
        ? [agent.clientId, String(agent.localAgentId)]
        : []),
    ) as any[];

    if (assignedTasks.length > 0) {
      workItems.push({
        type: 'assigned_tasks',
        count: assignedTasks.length,
        items: assignedTasks.map((t: any) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          due_date: t.due_date,
          ...resolveTaskImplementationTarget(t),
        }))
      });
    }
    
    // 3. Check for unread notifications
    const notifications = agent.aliases.flatMap((alias) => db_helpers.getUnreadNotifications(alias, workspaceId))
      .filter((notification, index, all) => all.findIndex((item) => item.id === notification.id) === index);
    
    if (notifications.length > 0) {
      workItems.push({
        type: 'notifications',
        count: notifications.length,
        items: notifications.slice(0, 5).map(n => ({
          id: n.id,
          type: n.type,
          title: n.title,
          message: n.message,
          created_at: n.created_at
        }))
      });
    }
    
    // 4. Check for urgent activities that might need attention
    const urgentActivities = db.prepare(`
      SELECT * FROM activities 
      WHERE type IN ('task_created', 'task_assigned', 'high_priority_alert')
      AND workspace_id = ?
      AND created_at > ?
      AND description LIKE ?
      ORDER BY created_at DESC
      LIMIT 5
    `).all(workspaceId, fourHoursAgo, `%${agent.name}%`);
    
    if (urgentActivities.length > 0) {
      workItems.push({
        type: 'urgent_activities',
        count: urgentActivities.length,
        items: urgentActivities.map((a: any) => ({
          id: a.id,
          type: a.type,
          description: a.description,
          created_at: a.created_at
        }))
      });
    }
    
    if (workItems.length === 0) {
      return NextResponse.json({
        status: 'HEARTBEAT_OK',
        agent: agent.name,
        checked_at: now,
        message: 'No work items found'
      });
    }
    
    return NextResponse.json({
      status: 'WORK_ITEMS_FOUND',
      agent: agent.name,
      checked_at: now,
      work_items: workItems,
      total_items: workItems.reduce((sum, item) => sum + item.count, 0)
    });
    
  } catch (error) {
    logger.error({ err: error }, 'GET /api/agents/[id]/heartbeat error');
    return NextResponse.json({ error: 'Failed to perform heartbeat check' }, { status: 500 });
  }
}

/**
 * POST /api/agents/[id]/heartbeat - Enhanced heartbeat
 *
 * Accepts optional body:
 * - connection_id: update direct_connections.last_heartbeat
 * - status: agent status override
 * - last_activity: activity description
 * - token_usage: { model, inputTokens, outputTokens, taskId? } for inline token reporting
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireRole(request, 'operator');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const rateLimited = agentHeartbeatLimiter(request);
  if (rateLimited) return rateLimited;

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    // No body is fine — fall through to standard heartbeat
  }

  const { connection_id, token_usage } = body;
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);
  const workspaceId = auth.user.workspace_id ?? 1;

  const resolvedParams = await params;
  const routeAgentId = resolvedParams.id;
  let postAgent: any;
  if (isNaN(Number(routeAgentId))) {
    postAgent = db.prepare('SELECT * FROM agents WHERE name = ? AND workspace_id = ?').get(routeAgentId, workspaceId);
  } else {
    postAgent = db.prepare('SELECT * FROM agents WHERE id = ? AND workspace_id = ?').get(Number(routeAgentId), workspaceId);
  }
  if (!postAgent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }

  // Update direct connection heartbeat if connection_id provided
  if (connection_id) {
    db.prepare('UPDATE direct_connections SET last_heartbeat = ?, updated_at = ? WHERE connection_id = ? AND status = ? AND workspace_id = ?')
      .run(now, now, connection_id, 'connected', workspaceId);
  }

  // Inline token reporting
  let tokenRecorded = false;
  if (token_usage && token_usage.model && token_usage.inputTokens != null && token_usage.outputTokens != null) {
    const agent = postAgent
    const sessionId = `${agent.name}:cli`
    const parsedTaskId =
      token_usage.taskId != null && Number.isFinite(Number(token_usage.taskId))
        ? Number(token_usage.taskId)
        : null

    let taskId: number | null = null
    if (parsedTaskId && parsedTaskId > 0) {
      const taskRow = db.prepare(
        'SELECT id FROM tasks WHERE id = ? AND workspace_id = ?'
      ).get(parsedTaskId, workspaceId) as { id?: number } | undefined
      if (taskRow?.id) {
        taskId = taskRow.id
      } else {
        logger.warn({ taskId: parsedTaskId, workspaceId, agent: agent.name }, 'Ignoring token usage with unknown taskId')
      }
    }

    db.prepare(
      `INSERT INTO token_usage (model, session_id, input_tokens, output_tokens, created_at, workspace_id, task_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      token_usage.model,
      sessionId,
      token_usage.inputTokens,
      token_usage.outputTokens,
      now,
      workspaceId,
      taskId
    )
    tokenRecorded = true
  }

  // Client / CLI reported heartbeat — update presence (GET checks work items only, no status writes)
  type AgentPresence = 'online' | 'offline' | 'busy' | 'idle' | 'error'
  const allowed: AgentPresence[] = ['online', 'offline', 'busy', 'idle', 'error']
  let nextStatus: AgentPresence = 'idle'
  if (body.status && allowed.includes(body.status as AgentPresence)) {
    nextStatus = body.status as AgentPresence
  } else if (connection_id) {
    nextStatus = 'online'
  }
  const activity =
    typeof body.last_activity === 'string' && body.last_activity.trim()
      ? body.last_activity.trim()
      : connection_id
        ? 'Connection heartbeat'
        : 'API heartbeat'
  db_helpers.updateAgentStatus(postAgent.name, nextStatus as any, activity, workspaceId)

  // Reuse GET logic for work-items check, then augment response
  const getResponse = await GET(request, { params });
  const getBody = await getResponse.json();

  return NextResponse.json({
    ...getBody,
    token_recorded: tokenRecorded,
  });
}
