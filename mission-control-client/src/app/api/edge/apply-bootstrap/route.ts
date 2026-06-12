import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, logAuditEvent } from '@/lib/db'
import { restartRemoteBridge } from '@/lib/remote-server-bridge'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function isLoopback(request: NextRequest): boolean {
  const forwarded = (request.headers.get('x-forwarded-for') || '').split(',')[0]?.trim()
  const host = forwarded || request.headers.get('x-real-ip') || ''
  // Direct local connection (tray / curl) — no proxy client IP headers
  if (!host) {
    return true
  }
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

function allowBootstrapApply(request: NextRequest): boolean {
  if (!isLoopback(request)) return false
  if (process.env.MC_EDGE_ALLOW_BOOTSTRAP === '1') return true
  if (request.headers.get('x-edge-tray') === '1') return true
  return false
}

/**
 * POST /api/edge/apply-bootstrap — Apply settings from tray (localhost only).
 * Body: { settings: Record<string, string>, reconnect_bridge?: boolean }
 */
export async function POST(request: NextRequest) {
  if (!allowBootstrapApply(request)) {
    return NextResponse.json(
      {
        error:
          'Bootstrap apply disabled. Use loopback only; set MC_EDGE_ALLOW_BOOTSTRAP=1 on the 5101 process or restart via E-Agent Edge tray.',
      },
      { status: 403 },
    )
  }

  let body: { settings?: Record<string, string>; reconnect_bridge?: boolean }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const settings = body?.settings
  if (!settings || typeof settings !== 'object') {
    return NextResponse.json({ error: 'settings object required' }, { status: 400 })
  }

  const db = getDatabase()
  const upsert = db.prepare(`
    INSERT INTO settings (key, value, description, category, updated_by, updated_at)
    VALUES (?, ?, ?, ?, 'edge-tray', unixepoch())
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_by = excluded.updated_by,
      updated_at = unixepoch()
  `)

  const updated: string[] = []
  const txn = db.transaction(() => {
    for (const [key, value] of Object.entries(settings)) {
      if (!key.startsWith('gateway.') && !key.startsWith('device.') && !key.startsWith('edge.') && !key.startsWith('general.')) {
        continue
      }
      const strValue = String(value ?? '')
      const category = key.split('.')[0] || 'edge'
      upsert.run(key, strValue, `Edge tray bootstrap: ${key}`, category)
      updated.push(key)
    }
  })
  txn()

  logAuditEvent({
    action: 'edge_bootstrap_apply',
    actor: 'edge-tray',
    detail: { keys: updated },
  })

  if (body.reconnect_bridge !== false) {
    restartRemoteBridge()
  }

  return NextResponse.json({ ok: true, updated })
}
