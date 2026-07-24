import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, db_helpers, logAuditEvent } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { writeAgentToConfig, enrichAgentConfigFromWorkspace, removeAgentFromConfig } from '@/lib/agent-sync'
import { eventBus } from '@/lib/event-bus'
import { logger } from '@/lib/logger'
import { runOpenClaw } from '@/lib/command'
import {
  getBridgeAgentIndexById,
  bridgeIndexRowToAgentListItem,
  mergeBridgeIndexIntoConfig,
} from '@/lib/sync-agent-index'
import { isBridgeClientOnline, requestBridgeClientAgentDetail } from '@/lib/bridge-server'
import { resolveAgentQueryIdentity } from '@/lib/agent-query-identity'
import {
  deleteHumanWatchStewardOnEdge,
  resolveBridgeStewardHumanWatch,
  updateHumanWatchStewardOnEdge,
} from '@/lib/human-watch-remote'

/**
 * GET /api/agents/[id] - Get a single agent by ID or name
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const db = getDatabase()
    const { id } = await params
    const workspaceId = auth.user.workspace_id ?? 1;

    const identity = resolveAgentQueryIdentity(db, id, workspaceId)
    if (!identity) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }
    if (identity.source === 'bridge_index') {
      const indexRow = identity.record as any
      const bridgeOnline = isBridgeClientOnline(indexRow.client_id)
      if (bridgeOnline) {
        try {
          const remote = await requestBridgeClientAgentDetail({
            clientId: indexRow.client_id,
            localAgentId: indexRow.local_agent_id,
          })
          if (remote.agent) {
            const remoteAgent = remote.agent as Record<string, unknown>
            let config: Record<string, unknown> = {}
            if (remoteAgent.config && typeof remoteAgent.config === 'object') {
              config = remoteAgent.config as Record<string, unknown>
            } else if (typeof remoteAgent.config === 'string') {
              try {
                config = JSON.parse(remoteAgent.config) as Record<string, unknown>
              } catch {
                config = {}
              }
            }
            return NextResponse.json({
              agent: {
                ...remoteAgent,
                id: indexRow.id,
                name: indexRow.remote_name,
                source: 'bridge_index',
                node_id: indexRow.client_id,
                edge_local_agent_id: indexRow.local_agent_id,
                bridge_client_id: indexRow.client_id,
                config: enrichAgentConfigFromWorkspace(
                  mergeBridgeIndexIntoConfig(config, indexRow),
                ),
                bridge_online: true,
                remote: true,
                detail_live: true,
              },
            })
          }
        } catch (bridgeErr) {
          const msg = bridgeErr instanceof Error ? bridgeErr.message : String(bridgeErr)
          if (/not connected|socket unavailable|timed out/i.test(msg)) {
            return NextResponse.json({
              error:
                '边缘客户端未通过 Bridge 连接，无法读取智能体详情。请保持本地客户端运行并已连上中心 Bridge。',
              code: 'bridge_offline',
              client_id: indexRow.client_id,
            }, { status: 503 })
          }
          throw bridgeErr
        }
      }

      const cached = bridgeIndexRowToAgentListItem(indexRow, false)
      return NextResponse.json({
        agent: {
          ...cached,
          config: enrichAgentConfigFromWorkspace(cached.config as Record<string, unknown>),
          bridge_online: false,
          detail_cached: true,
        },
      })
    }

    const agent = identity.record
    const parsed = {
      ...agent,
      config: enrichAgentConfigFromWorkspace(
        typeof agent.config === 'string' ? JSON.parse(agent.config || '{}') : (agent.config || {}),
      ),
    }

    return NextResponse.json({ agent: parsed })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/agents/[id] error')
    return NextResponse.json({ error: 'Failed to fetch agent' }, { status: 500 })
  }
}

/**
 * PUT /api/agents/[id] - Update agent config with unified MC + gateway save
 *
 * Body: {
 *   role?: string
 *   gateway_config?: object   - OpenClaw agent config fields to update
 *   write_to_gateway?: boolean - Defaults to true when gateway_config exists
 * }
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const db = getDatabase()
    const { id } = await params
    const workspaceId = auth.user.workspace_id ?? 1;
    const body = await request.json()
    const { role, gateway_config, write_to_gateway, soul_content, name: bodyName } = body

    const numericId = Number(id)
    if (!isNaN(numericId)) {
      const indexRow = getBridgeAgentIndexById(numericId)
      if (indexRow && (await resolveBridgeStewardHumanWatch(indexRow))) {
        try {
          const configPatch =
            gateway_config && typeof gateway_config === 'object'
              ? (gateway_config as Record<string, unknown>)
              : null
          const remoteAgent = await updateHumanWatchStewardOnEdge({
            indexRow,
            name: typeof bodyName === 'string' ? bodyName : undefined,
            soulContent: typeof soul_content === 'string' ? soul_content : undefined,
            configPatch,
          })
          return NextResponse.json({
            success: true,
            agent: {
              id: indexRow.id,
              name: indexRow.remote_name,
              role: indexRow.role,
              framework: indexRow.framework,
              config: remoteAgent?.config ?? configPatch,
              remote: true,
              bridge_online: true,
            },
          })
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Failed to update steward on edge'
          return NextResponse.json({ error: message }, { status: 503 })
        }
      }
    }

    let agent
    if (isNaN(Number(id))) {
      agent = db.prepare('SELECT * FROM agents WHERE name = ? AND workspace_id = ?').get(id, workspaceId) as any
    } else {
      agent = db.prepare('SELECT * FROM agents WHERE id = ? AND workspace_id = ?').get(Number(id), workspaceId) as any
    }

    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    const now = Math.floor(Date.now() / 1000)
    const existingConfig = agent.config ? JSON.parse(agent.config) : {}

    // Merge gateway_config into existing config
    let newConfig = existingConfig
    if (gateway_config && typeof gateway_config === 'object') {
      newConfig = { ...existingConfig, ...gateway_config }
    }

    const shouldWriteToGateway = Boolean(
      gateway_config &&
      (write_to_gateway === undefined || write_to_gateway === null || write_to_gateway === true)
    )
    const openclawId = existingConfig.openclawId || agent.name.toLowerCase().replace(/\s+/g, '-')
    const getWriteBackPayload = (source: Record<string, any>) => {
      const writeBack: any = { id: openclawId }
      if (source.model) writeBack.model = source.model
      if (source.identity) writeBack.identity = source.identity
      if (source.sandbox) writeBack.sandbox = source.sandbox
      if (source.tools) writeBack.tools = source.tools
      if (source.subagents) writeBack.subagents = source.subagents
      if (source.memorySearch) writeBack.memorySearch = source.memorySearch
      return writeBack
    }

    // Unified save: DB first (transactional, easy to revert), then gateway file.
    // If gateway write fails after DB succeeds, revert DB to keep consistency.
    try {
      const fields: string[] = ['updated_at = ?']
      const values: any[] = [now]

      if (role !== undefined) {
        fields.push('role = ?')
        values.push(role)
      }

      if (gateway_config) {
        fields.push('config = ?')
        values.push(JSON.stringify(newConfig))
      }

      values.push(agent.id, workspaceId)
      db.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ? AND workspace_id = ?`).run(...values)
    } catch (err: any) {
      return NextResponse.json({ error: `Save failed: ${err.message}` }, { status: 500 })
    }

    if (shouldWriteToGateway) {
      try {
        await writeAgentToConfig(getWriteBackPayload(gateway_config))
      } catch (err: any) {
        // Gateway write failed — revert DB to previous state
        try {
          const revertFields: string[] = ['updated_at = ?']
          const revertValues: any[] = [agent.updated_at]
          revertFields.push('role = ?')
          revertValues.push(agent.role)
          revertFields.push('config = ?')
          revertValues.push(agent.config || '{}')
          revertValues.push(agent.id, workspaceId)
          db.prepare(`UPDATE agents SET ${revertFields.join(', ')} WHERE id = ? AND workspace_id = ?`).run(...revertValues)
        } catch (revertErr: any) {
          logger.error({ err: revertErr, agent: agent.name }, 'Failed to revert DB after gateway write failure')
        }
        return NextResponse.json(
          { error: `Save failed: unable to update gateway config: ${err.message}` },
          { status: 502 }
        )
      }
    }

    if (shouldWriteToGateway) {
      const ipAddress = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown'
      logAuditEvent({
        action: 'agent_config_writeback',
        actor: auth.user.username,
        actor_id: auth.user.id,
        target_type: 'agent',
        target_id: agent.id,
        detail: { agent_name: agent.name, openclaw_id: openclawId, fields: Object.keys(gateway_config || {}) },
        ip_address: ipAddress,
      })
    }

    // Log activity
    db_helpers.logActivity(
      'agent_config_updated',
      'agent',
      agent.id,
      auth.user.username,
      `Config updated for agent ${agent.name}${shouldWriteToGateway ? ' (+ gateway)' : ''}`,
      { fields: Object.keys(gateway_config || {}), write_to_gateway: shouldWriteToGateway },
      workspaceId
    )

    // Broadcast update
    eventBus.broadcast('agent.updated', {
      id: agent.id,
      name: agent.name,
      config: newConfig,
      updated_at: now,
    })

    const enrichedConfig = enrichAgentConfigFromWorkspace(newConfig)

    return NextResponse.json({
      success: true,
      agent: { ...agent, config: enrichedConfig, role: role || agent.role, updated_at: now },
    })
  } catch (error: any) {
    logger.error({ err: error }, 'PUT /api/agents/[id] error')
    return NextResponse.json({ error: error.message || 'Failed to update agent' }, { status: 500 })
  }
}

/**
 * DELETE /api/agents/[id] - Delete an agent
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const db = getDatabase()
    const { id } = await params
    const workspaceId = auth.user.workspace_id ?? 1;
    let removeWorkspace = false
    try {
      const body = await request.json()
      removeWorkspace = Boolean(body?.remove_workspace)
    } catch {
      // Optional body
    }

    const numericId = Number(id)
    if (!isNaN(numericId)) {
      const indexRow = getBridgeAgentIndexById(numericId)
      if (indexRow && (await resolveBridgeStewardHumanWatch(indexRow))) {
        try {
          const result = await deleteHumanWatchStewardOnEdge({
            workspaceId,
            indexRow,
          })
          db_helpers.logActivity(
            'agent_deleted',
            'agent',
            indexRow.id,
            auth.user.username,
            `Deleted human-watch steward: ${result.deleted}`,
            {
              name: result.deleted,
              client_id: indexRow.client_id,
              bindings_removed: result.bindingsRemoved,
            },
            workspaceId,
          )
          eventBus.broadcast('agent.deleted', {
            id: indexRow.id,
            name: indexRow.remote_name,
          })
          return NextResponse.json({
            success: true,
            deleted: result.deleted,
            bindings_removed: result.bindingsRemoved,
            remote: true,
          })
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Failed to delete steward on edge'
          return NextResponse.json({ error: message }, { status: 503 })
        }
      }
    }

    let agent
    if (isNaN(Number(id))) {
      agent = db.prepare('SELECT * FROM agents WHERE name = ? AND workspace_id = ?').get(id, workspaceId) as any
    } else {
      agent = db.prepare('SELECT * FROM agents WHERE id = ? AND workspace_id = ?').get(Number(id), workspaceId) as any
    }

    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    if (removeWorkspace) {
      const agentConfig = agent.config ? JSON.parse(agent.config) : {}
      const openclawId =
        String(agentConfig?.openclawId || agent.name || '')
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, '-')
          .replace(/^-+|-+$/g, '') || agent.name
      try {
        await runOpenClaw(['agents', 'delete', openclawId, '--force'], { timeoutMs: 30000 })
      } catch (err: any) {
        logger.error({ err, openclawId, agent: agent.name }, 'Failed to remove OpenClaw agent/workspace')
        return NextResponse.json(
          { error: `Failed to remove OpenClaw workspace for ${agent.name}: ${err?.message || 'unknown error'}` },
          { status: 502 }
        )
      }
    }

    let configCleanupWarning: string | null = null
    try {
      const agentConfig = agent.config ? JSON.parse(agent.config) : {}
      const openclawId =
        String(agentConfig?.openclawId || agent.name || '')
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, '-')
          .replace(/^-+|-+$/g, '') || agent.name
      await removeAgentFromConfig({ id: openclawId, name: agent.name })
    } catch (err: any) {
      configCleanupWarning = `OpenClaw config cleanup skipped for ${agent.name}: ${err?.message || 'unknown error'}`
      logger.warn({ err, agent: agent.name }, 'Failed to remove OpenClaw agent config entry')
    }

    db.prepare('DELETE FROM agents WHERE id = ? AND workspace_id = ?').run(agent.id, workspaceId)

    db_helpers.logActivity(
      'agent_deleted',
      'agent',
      agent.id,
      auth.user.username,
      `Deleted agent: ${agent.name}`,
      { name: agent.name, role: agent.role, remove_workspace: removeWorkspace },
      workspaceId
    )

    eventBus.broadcast('agent.deleted', { id: agent.id, name: agent.name })

    return NextResponse.json({
      success: true,
      deleted: agent.name,
      remove_workspace: removeWorkspace,
      ...(configCleanupWarning ? { warning: configCleanupWarning } : {}),
    })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/agents/[id] error')
    return NextResponse.json({ error: 'Failed to delete agent' }, { status: 500 })
  }
}
