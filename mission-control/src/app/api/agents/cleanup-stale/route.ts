import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

/**
 * POST /api/agents/cleanup-stale
 * Hide stale mirrored client agents so they no longer occupy the squad view.
 *
 * Body:
 * {
 *   client_id?: string,
 *   mode?: 'hide' | 'delete'   // default: hide
 * }
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  let body: Record<string, unknown> = {}
  try {
    body = await request.json()
  } catch {
    body = {}
  }

  const workspaceId = auth.user.workspace_id ?? 1
  const clientId = typeof body.client_id === 'string' ? body.client_id.trim() : ''
  const mode = body.mode === 'delete' ? 'delete' : 'hide'
  const db = getDatabase()

  try {
    const clauses = [
      'a.workspace_id = ?',
      "a.source = 'client'",
      "a.status = 'offline'",
      'COALESCE(a.hidden, 0) = 0',
      `NOT EXISTS (
        SELECT 1
        FROM human_watch_bindings b
        WHERE b.workspace_id = a.workspace_id
          AND b.client_id = a.node_id
          AND (
            b.worker_local_agent_id = CAST(json_extract(a.config, '$.local_agent_id') AS INTEGER)
            OR b.steward_local_agent_id = CAST(json_extract(a.config, '$.local_agent_id') AS INTEGER)
          )
      )`,
    ]
    const params: Array<string | number> = [workspaceId]

    if (clientId) {
      clauses.push('a.node_id = ?')
      params.push(clientId)
    }

    const rows = db.prepare(`
      SELECT a.id, a.name, a.node_id
      FROM agents a
      WHERE ${clauses.join(' AND ')}
      ORDER BY a.updated_at DESC, a.id DESC
    `).all(...params) as Array<{ id: number; name: string; node_id: string | null }>

    if (rows.length === 0) {
      return NextResponse.json({ success: true, mode, affected: 0, agents: [] })
    }

    if (mode === 'delete') {
      const stmt = db.prepare('DELETE FROM agents WHERE id = ? AND workspace_id = ?')
      db.transaction(() => {
        for (const row of rows) stmt.run(row.id, workspaceId)
      })()
    } else {
      const stmt = db.prepare('UPDATE agents SET hidden = 1, updated_at = unixepoch() WHERE id = ? AND workspace_id = ?')
      db.transaction(() => {
        for (const row of rows) stmt.run(row.id, workspaceId)
      })()
    }

    return NextResponse.json({
      success: true,
      mode,
      affected: rows.length,
      agents: rows.map((row) => ({ id: row.id, name: row.name, client_id: row.node_id || null })),
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/agents/cleanup-stale error')
    return NextResponse.json({ error: 'Failed to cleanup stale agents' }, { status: 500 })
  }
}
