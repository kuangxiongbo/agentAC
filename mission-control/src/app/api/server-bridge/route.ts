import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getRemoteBridgeStatus, startRemoteBridge, stopRemoteBridge, sendBridgeEvent } from '@/lib/remote-server-bridge'
import { getBridgeServerStatus } from '@/lib/bridge-server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  return NextResponse.json({
    bridge: getRemoteBridgeStatus(),
    service: getBridgeServerStatus(),
  })
}

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
      stopRemoteBridge()
      await new Promise(r => setTimeout(r, 500))
      startRemoteBridge()
      return NextResponse.json({ ok: true, message: 'Bridge reconnecting', bridge: getRemoteBridgeStatus() })
    case 'status_push': {
      const { getDatabase } = await import('@/lib/db')
      const db = getDatabase()
      const agents = db.prepare(`SELECT id, name, role, status FROM agents WHERE hidden = 0 ORDER BY name`).all()
      const clientId = (db.prepare(`SELECT value FROM settings WHERE key = 'device.client_id'`).get() as { value?: string } | undefined)?.value || 'mc-node-static'
      const clientLabel = (db.prepare(`SELECT value FROM settings WHERE key = 'gateway.client_name'`).get() as { value?: string } | undefined)?.value || clientId
      const sent = sendBridgeEvent('agent_status', { clientId, clientLabel, agents })
      return NextResponse.json({ ok: sent, message: sent ? 'Status pushed' : 'Bridge not connected' })
    }
    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
  }
}
