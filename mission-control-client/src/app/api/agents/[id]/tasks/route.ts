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
    const agent = db.prepare(`SELECT id, name, session_key FROM agents
      WHERE workspace_id = ? AND (id = ? OR name = ?) LIMIT 1`)
      .get(workspaceId, Number.isInteger(numericId) ? numericId : -1, id) as any
    if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    const aliases = [...new Set([agent.name, agent.session_key].filter(Boolean))]
    const rows = db.prepare(`
      SELECT t.*, p.name AS project_name, p.ticket_prefix AS project_prefix
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
      WHERE t.workspace_id = ? AND t.assigned_to IN (${aliases.map(() => '?').join(', ')})
      ORDER BY t.updated_at DESC LIMIT 200
    `).all(workspaceId, ...aliases) as any[]
    const tasks = rows.map((task) => ({
      ...task,
      tags: task.tags ? JSON.parse(task.tags) : [],
      metadata: task.metadata ? JSON.parse(task.metadata) : {},
      ticket_ref: task.project_prefix && task.project_ticket_no
        ? `${task.project_prefix}-${String(task.project_ticket_no).padStart(3, '0')}`
        : undefined,
    }))
    return NextResponse.json({ tasks, total: tasks.length })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/agents/[id]/tasks error')
    return NextResponse.json({ error: 'Failed to fetch agent tasks' }, { status: 500 })
  }
}
