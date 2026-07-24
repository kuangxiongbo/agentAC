import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getDatabase } from '@/lib/db'
import { resolveAgentQueryIdentity, sqlPlaceholders } from '@/lib/agent-query-identity'
import { logger } from '@/lib/logger'
import { isBridgeClientOnline, requestBridgeClientAgentDetail } from '@/lib/bridge-server'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  try {
    const db = getDatabase()
    const { id } = await params
    const workspaceId = auth.user.workspace_id ?? 1
    const identity = resolveAgentQueryIdentity(db, id, workspaceId)
    if (!identity) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    const requested = Number(new URL(request.url).searchParams.get('limit') || 100)
    const limit = Math.min(Math.max(Number.isFinite(requested) ? requested : 100, 1), 200)
    const conditions = [`t.assigned_to IN (${sqlPlaceholders(identity.aliases)})`]
    const queryParams: unknown[] = [workspaceId, ...identity.aliases]
    if (identity.clientId && identity.localAgentId != null) {
      conditions.push(`(g.client_id = ? AND sgt.assigned_agent_id = ?)`)
      queryParams.push(identity.clientId, String(identity.localAgentId))
    }
    const rows = db.prepare(`
      SELECT DISTINCT t.*, p.name AS project_name, p.ticket_prefix AS project_prefix
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
      LEFT JOIN supervision_goal_tasks sgt ON sgt.task_id = t.id
      LEFT JOIN supervision_goals g ON g.id = sgt.goal_id AND g.workspace_id = t.workspace_id
      WHERE t.workspace_id = ? AND (${conditions.join(' OR ')})
      ORDER BY t.updated_at DESC LIMIT ?
    `).all(...queryParams, limit) as any[]
    const cloudTasks = rows.map((task) => ({
      ...task,
      tags: task.tags ? JSON.parse(task.tags) : [],
      metadata: task.metadata ? JSON.parse(task.metadata) : {},
      ticket_ref: task.project_prefix && task.project_ticket_no
        ? `${task.project_prefix}-${String(task.project_ticket_no).padStart(3, '0')}`
        : undefined,
      source: 'cloud_control',
    }))
    let localTasks: any[] = []
    let localLive = false
    if (
      identity.source === 'bridge_index'
      && identity.clientId
      && identity.localAgentId != null
      && isBridgeClientOnline(identity.clientId)
    ) {
      try {
        const remote = await requestBridgeClientAgentDetail({
          clientId: identity.clientId,
          localAgentId: identity.localAgentId,
        })
        const received = remote.agent?.recent_tasks
        if (Array.isArray(received)) {
          localLive = true
          localTasks = received.map((task) => ({ ...task, source: 'local_runtime' }))
        }
      } catch (error) {
        logger.warn({ err: error, clientId: identity.clientId }, 'Local agent task detail unavailable')
      }
    }
    const seen = new Set<string>()
    const tasks = [...localTasks, ...cloudTasks].filter((task) => {
      const metadata = task?.metadata && typeof task.metadata === 'object' ? task.metadata : {}
      const key = String(metadata.goal_task_id || metadata.remote_task_id || `${task.source}:${task.id}`)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    return NextResponse.json({
      tasks,
      total: tasks.length,
      authority: identity.source === 'bridge_index' ? 'local_runtime' : 'cloud',
      local_live: localLive,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/agents/[id]/tasks error')
    return NextResponse.json({ error: 'Failed to fetch agent tasks' }, { status: 500 })
  }
}
