import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getDatabase } from '@/lib/db'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  try {
    const db = getDatabase()
    const { id } = await params
    const workspaceId = auth.user.workspace_id ?? 1
    const numericId = Number(id)
    const agent = db.prepare(`
      SELECT id, name, session_key, status, last_activity, updated_at
      FROM agents WHERE workspace_id = ? AND (id = ? OR name = ?) LIMIT 1
    `).get(workspaceId, Number.isInteger(numericId) ? numericId : -1, id) as any
    if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })

    const requested = Number(new URL(request.url).searchParams.get('limit') || 50)
    const limit = Math.min(Math.max(Number.isFinite(requested) ? requested : 50, 1), 100)
    const aliases = [...new Set([agent.name, agent.session_key].filter(Boolean))]
    const placeholders = aliases.map(() => '?').join(', ')
    const activities = db.prepare(`
      SELECT 'activity:' || id AS id, type, 'activity' AS source, NULL AS status,
             description, created_at, NULL AS task_id
      FROM activities
      WHERE workspace_id = ? AND actor IN (${placeholders})
      UNION ALL
      SELECT 'task:' || id || ':' || updated_at AS id, 'task_status' AS type,
             'task' AS source, status, 'Task #' || id || ' ' || title AS description,
             updated_at AS created_at, id AS task_id
      FROM tasks
      WHERE workspace_id = ? AND assigned_to IN (${placeholders})
      ORDER BY created_at DESC LIMIT ?
    `).all(workspaceId, ...aliases, workspaceId, ...aliases, limit)
    if (!activities.length && agent.last_activity) {
      activities.push({
        id: `agent:${agent.id}:${agent.updated_at}`,
        type: 'agent_status', source: 'sync', status: agent.status,
        description: agent.last_activity, created_at: agent.updated_at, task_id: null,
      })
    }
    return NextResponse.json({ activities, total: activities.length })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/agents/[id]/activity error')
    return NextResponse.json({ error: 'Failed to fetch agent activity' }, { status: 500 })
  }
}
