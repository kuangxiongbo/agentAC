import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { upsertSyncClientHeartbeat } from '@/lib/sync-clients'
import { config } from '@/lib/config'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const clientName = typeof body?.client_name === 'string' ? body.client_name.trim() : ''
  const clientIdRaw = typeof body?.client_id === 'string' ? body.client_id.trim() : ''
  const clientId = clientIdRaw || clientName
  const previousClientName = typeof body?.previous_client_name === 'string' ? body.previous_client_name.trim() : ''
  const agentCount = typeof body?.agent_count === 'number' ? body.agent_count : 0

  if (!clientId || !clientName) {
    return NextResponse.json({ error: 'client_id and client_name are required' }, { status: 400 })
  }

  if (previousClientName && previousClientName !== clientName) {
    const { getDatabase } = await import('@/lib/db')
    const db = getDatabase()
    db.prepare(`
      DELETE FROM sync_clients
      WHERE client_id = ? OR client_name = ?
    `).run(previousClientName, previousClientName)
  }

  const client = upsertSyncClientHeartbeat({
    clientId,
    clientName,
    agentCount,
    source: 'heartbeat',
  })

  return NextResponse.json({
    ok: true,
    client,
    agent_sync_mode: 'full',
  })
}
