import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getRemoteBridgeStatus, startRemoteBridge, stopRemoteBridge, restartRemoteBridge, sendBridgeEvent } from '@/lib/remote-server-bridge'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/server-bridge — Get current remote bridge connection status
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const status = getRemoteBridgeStatus()
  return NextResponse.json({ bridge: status })
}

/**
 * POST /api/server-bridge — Control bridge lifecycle or send events
 *
 * Body: { action: 'start' | 'stop' | 'reconnect' | 'status_push' }
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  let body: any
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Request body required' }, { status: 400 })
  }

  const { action } = body || {}

  switch (action) {
    case 'start':
      startRemoteBridge()
      return NextResponse.json({ ok: true, message: 'Bridge start requested', bridge: getRemoteBridgeStatus() })

    case 'stop':
      stopRemoteBridge()
      return NextResponse.json({ ok: true, message: 'Bridge stopped', bridge: getRemoteBridgeStatus() })

    case 'reconnect':
      restartRemoteBridge()
      await new Promise((r) => setTimeout(r, 800))
      return NextResponse.json({ ok: true, message: 'Bridge reconnecting', bridge: getRemoteBridgeStatus() })

    case 'status_push': {
      const { getDatabase } = await import('@/lib/db')
      const db = getDatabase()
      const agents = db.prepare(
        `SELECT id, name, role, status, framework, parent_id, session_key FROM agents WHERE hidden = 0 ORDER BY name`
      ).all()
      const clientId = (db.prepare(`SELECT value FROM settings WHERE key = 'device.client_id'`).get() as { value?: string } | undefined)?.value || 'mc-node-static'
      const clientLabel = (db.prepare(`SELECT value FROM settings WHERE key = 'gateway.client_name'`).get() as { value?: string } | undefined)?.value || clientId
      const sent = sendBridgeEvent('agent_status', { clientId, clientLabel, agents })
      return NextResponse.json({ ok: sent, message: sent ? 'Status pushed' : 'Bridge not connected' })
    }

    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
  }
}
