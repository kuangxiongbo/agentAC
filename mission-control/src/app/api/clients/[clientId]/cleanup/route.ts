import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'

type RouteContext = {
  params: Promise<{ clientId: string }>
}

export const dynamic = 'force-dynamic'

/**
 * DELETE /api/clients/:clientId/cleanup
 * Remove a disconnected client and its mirrored agent/session cache data.
 *
 * Query/body:
 * - confirm=delete-client-data
 */
export async function DELETE(request: NextRequest, context: RouteContext) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const workspaceId = auth.user.workspace_id ?? 1
  const { clientId: rawClientId } = await context.params
  const clientId = String(rawClientId || '').trim()
  if (!clientId) {
    return NextResponse.json({ error: 'clientId is required' }, { status: 400 })
  }

  const confirmQuery = request.nextUrl.searchParams.get('confirm')?.trim() || ''
  let confirmBody = ''
  try {
    const body = await request.json()
    confirmBody = typeof body?.confirm === 'string' ? body.confirm.trim() : ''
  } catch {
    // allow empty body
  }
  const confirm = confirmBody || confirmQuery
  if (confirm !== 'delete-client-data') {
    return NextResponse.json({
      error: 'Explicit confirmation required',
      required_confirm: 'delete-client-data',
    }, { status: 400 })
  }

  const db = getDatabase()
  try {
    const bindingCount = (db.prepare(`
      SELECT COUNT(*) as c
      FROM human_watch_bindings
      WHERE workspace_id = ? AND client_id = ?
    `).get(workspaceId, clientId) as { c: number } | undefined)?.c || 0
    if (bindingCount > 0) {
      return NextResponse.json({
        error: 'Client still has human-watch bindings',
        bindings: bindingCount,
      }, { status: 409 })
    }

    const sessionCount = (db.prepare(`
      SELECT COUNT(*) as c
      FROM session_sync
      WHERE workspace_id = ? AND client_id = ?
    `).get(workspaceId, clientId) as { c: number } | undefined)?.c || 0

    const clientAgentRows = db.prepare(`
      SELECT id, name
      FROM agents
      WHERE workspace_id = ? AND source = 'client' AND node_id = ?
    `).all(workspaceId, clientId) as Array<{ id: number; name: string }>

    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM sync_clients WHERE workspace_id = ? AND client_id = ?`).run(workspaceId, clientId)
      db.prepare(`DELETE FROM sync_agent_index WHERE client_id = ?`).run(clientId)
      db.prepare(`DELETE FROM session_sync WHERE workspace_id = ? AND client_id = ?`).run(workspaceId, clientId)
      db.prepare(`DELETE FROM agents WHERE workspace_id = ? AND source = 'client' AND node_id = ?`).run(workspaceId, clientId)
    })
    tx()

    return NextResponse.json({
      success: true,
      client_id: clientId,
      removed_agents: clientAgentRows.length,
      removed_sessions: sessionCount,
    })
  } catch (error) {
    logger.error({ err: error, clientId }, 'DELETE /api/clients/[clientId]/cleanup error')
    return NextResponse.json({ error: 'Failed to cleanup client data' }, { status: 500 })
  }
}
