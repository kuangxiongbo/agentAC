import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, db_helpers } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { agentRegisterLimiter, selfRegisterLimiter } from '@/lib/rate-limit'
import { logAuditEvent } from '@/lib/db'
import { eventBus } from '@/lib/event-bus'
import { logger } from '@/lib/logger'
import { config } from '@/lib/config'
import { readSyncClientIdentity, upsertSyncClientHeartbeat } from '@/lib/sync-clients'

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/
const VALID_ROLES = ['coder', 'reviewer', 'tester', 'devops', 'researcher', 'assistant', 'agent']

/**
 * POST /api/agents/register — Agent self-registration.
 *
 * Allows agents to register themselves with minimal auth (viewer role).
 * If an agent with the same name already exists, returns the existing agent
 * (idempotent upsert on status/last_seen).
 *
 * Body: { name, role?, capabilities?, framework? }
 *
 * Rate-limited to 5 registrations/min per IP for unauthenticated/self-hosted spam control,
 * or 10/min per agent identity when x-agent-name is supplied by a trusted controller.
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const agentNameHeader = (request.headers.get('x-agent-name') || '').trim()
  const syncClient = readSyncClientIdentity(request.headers)
  const limited = agentNameHeader ? agentRegisterLimiter(request) : selfRegisterLimiter(request)
  if (limited) return limited

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Request body required' }, { status: 400 })
  }

  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  const role = typeof body?.role === 'string' ? body.role.trim() : 'agent'
  const capabilities = Array.isArray(body?.capabilities) ? body.capabilities.filter((c: any) => typeof c === 'string') : []
  const framework = typeof body?.framework === 'string' ? body.framework.trim() : null
  const requestedStatus = typeof body?.status === 'string' ? body.status.trim() : 'idle'
  const originalName = typeof body?.original_name === 'string' ? body.original_name.trim() : ''
  const parentName = typeof body?.parent_name === 'string' ? body.parent_name.trim() : ''

  if (!name || !NAME_RE.test(name)) {
    return NextResponse.json({
      error: 'Invalid agent name. Use 1-63 alphanumeric characters, dots, hyphens, or underscores. Must start with alphanumeric.',
    }, { status: 400 })
  }

  if (!VALID_ROLES.includes(role)) {
    return NextResponse.json({
      error: `Invalid role. Use: ${VALID_ROLES.join(', ')}`,
    }, { status: 400 })
  }

  try {
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    const now = Math.floor(Date.now() / 1000)

    if (syncClient) {
      const existing = db.prepare(
        'SELECT * FROM agents WHERE name = ? AND workspace_id = ?'
      ).get(name, workspaceId) as any | undefined

      const nextStatus = ['offline', 'idle', 'busy', 'error'].includes(requestedStatus) ? requestedStatus : 'idle'
      const existingConfig = existing?.config ? JSON.parse(existing.config) : {}
      const parentAgent = parentName
        ? db.prepare(`
            SELECT id
            FROM agents
            WHERE workspace_id = ?
              AND source = 'client'
              AND node_id = ?
              AND (
                json_extract(config, '$.original_name') = ?
                OR name = ?
              )
            LIMIT 1
          `).get(workspaceId, syncClient.clientId, parentName, parentName) as { id: number } | undefined
        : undefined
      const nextConfig = {
        ...existingConfig,
        ...(capabilities.length > 0 ? { capabilities } : {}),
        ...(framework ? { framework } : {}),
        node_label: syncClient.clientName,
        sync_client_id: syncClient.clientId,
        ...(originalName ? { original_name: originalName } : {}),
      }
      const configJson = JSON.stringify(nextConfig)

      const client = upsertSyncClientHeartbeat({
        clientId: syncClient.clientId,
        clientName: syncClient.clientName,
        workspaceId,
        agentCount: Number(request.headers.get('x-sync-agent-count') || '0') || 0,
        source: 'agent_register',
      })

      if (existing) {
        db.prepare(`
          UPDATE agents
          SET role = ?, status = ?, last_seen = ?, updated_at = ?, source = 'client', node_id = ?, config = ?, framework = COALESCE(?, framework), parent_id = ?
          WHERE id = ? AND workspace_id = ?
        `).run(role, nextStatus, now, now, syncClient.clientId, configJson, framework, parentAgent?.id || null, existing.id, workspaceId)

        eventBus.broadcast('agent.status_changed', {
          id: existing.id,
          name,
          status: nextStatus,
          last_seen: now,
        })

        return NextResponse.json({
          agent: {
            id: existing.id,
            name,
            role,
            status: nextStatus,
            created_at: existing.created_at,
          },
          registered: false,
          client_sync: true,
          client,
          message: 'Client agent sync updated',
        })
      }

      const result = db.prepare(`
        INSERT INTO agents (name, role, status, config, created_at, updated_at, last_seen, workspace_id, source, node_id, framework, parent_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'client', ?, ?, ?)
      `).run(name, role, nextStatus, configJson, now, now, now, workspaceId, syncClient.clientId, framework || null, parentAgent?.id || null)

      const agentId = Number(result.lastInsertRowid)

      eventBus.broadcast('agent.created', { id: agentId, name, role, status: nextStatus })

      return NextResponse.json({
        agent: {
          id: agentId,
          name,
          role,
          status: nextStatus,
          created_at: now,
        },
        registered: true,
        client_sync: true,
        client,
        message: 'Client agent synced',
      }, { status: 201 })
    }

    // Check if agent already exists — idempotent: update last_seen and status
    const existing = db.prepare(
      'SELECT * FROM agents WHERE name = ? AND workspace_id = ?'
    ).get(name, workspaceId) as any | undefined

    if (existing) {
      db.prepare(
        'UPDATE agents SET status = ?, last_seen = ?, updated_at = ? WHERE id = ? AND workspace_id = ?'
      ).run('idle', now, now, existing.id, workspaceId)

      return NextResponse.json({
        agent: {
          id: existing.id,
          name: existing.name,
          role: existing.role,
          status: 'idle',
          created_at: existing.created_at,
        },
        registered: false,
        message: 'Agent already registered, status updated',
      })
    }

    // Create new agent
    const config: Record<string, any> = {}
    if (capabilities.length > 0) config.capabilities = capabilities
    if (framework) config.framework = framework

    const result = db.prepare(`
      INSERT INTO agents (name, role, status, config, created_at, updated_at, last_seen, workspace_id)
      VALUES (?, ?, 'idle', ?, ?, ?, ?, ?)
    `).run(name, role, JSON.stringify(config), now, now, now, workspaceId)

    const agentId = Number(result.lastInsertRowid)

    db_helpers.logActivity(
      'agent_created',
      'agent',
      agentId,
      name,
      `Agent self-registered: ${name} (${role})${framework ? ` via ${framework}` : ''}`,
      { name, role, framework, capabilities, self_registered: true },
      workspaceId,
    )

    logAuditEvent({
      action: 'agent_self_register',
      actor: auth.user.username,
      actor_id: auth.user.id,
      target_type: 'agent',
      target_id: agentId,
      detail: { name, role, framework, self_registered: true },
      ip_address: request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown',
    })

    eventBus.broadcast('agent.created', { id: agentId, name, role, status: 'idle' })

    return NextResponse.json({
      agent: {
        id: agentId,
        name,
        role,
        status: 'idle',
        created_at: now,
      },
      registered: true,
      message: 'Agent registered successfully',
    }, { status: 201 })
  } catch (error: any) {
    if (error.message?.includes('UNIQUE constraint')) {
      // Race condition — another request registered the same name
      return NextResponse.json({ error: 'Agent name already exists' }, { status: 409 })
    }
    logger.error({ err: error }, 'POST /api/agents/register error')
    return NextResponse.json({ error: 'Registration failed' }, { status: 500 })
  }
}

export const dynamic = 'force-dynamic'
