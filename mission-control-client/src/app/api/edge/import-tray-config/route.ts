import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, logAuditEvent } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { readEdgeTrayConfigFile, trayFileToSettings } from '@/lib/edge-tray-config-file'
import { restartRemoteBridge } from '@/lib/remote-server-bridge'
import { shouldReconnectBridgeForSettingChange } from '@/lib/edge-bootstrap-settings'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function isLoopback(request: NextRequest): boolean {
  const forwarded = (request.headers.get('x-forwarded-for') || '').split(',')[0]?.trim()
  const host = forwarded || request.headers.get('x-real-ip') || ''
  if (!host) return true
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

function allowImport(request: NextRequest): boolean {
  if (request.headers.get('x-edge-tray') === '1') return true
  if (isLoopback(request)) return true
  return false
}

/**
 * POST /api/edge/import-tray-config — Pull ~/.e-agent-edge/config.json into Web settings DB.
 */
export async function POST(request: NextRequest) {
  let auth = requireRole(request, 'admin')
  if ('error' in auth && !allowImport(request)) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const tray = await readEdgeTrayConfigFile()
  if (!tray) {
    return NextResponse.json({ ok: true, updated: [], message: 'No tray config file' })
  }

  const incoming = trayFileToSettings(tray)
  if (Object.keys(incoming).length === 0) {
    return NextResponse.json({ ok: true, updated: [], message: 'Tray config empty' })
  }

  const db = getDatabase()
  const upsert = db.prepare(`
    INSERT INTO settings (key, value, description, category, updated_by, updated_at)
    VALUES (?, ?, ?, ?, 'edge-tray-import', unixepoch())
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_by = excluded.updated_by,
      updated_at = unixepoch()
  `)

  const updated: string[] = []
  let shouldReconnectBridge = false
  const txn = db.transaction(() => {
    for (const [key, value] of Object.entries(incoming)) {
      const previous = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
      if (shouldReconnectBridgeForSettingChange(key, previous?.value, value)) {
        shouldReconnectBridge = true
      }
      const category = key.split('.')[0] || 'edge'
      upsert.run(key, value, `Imported from tray config: ${key}`, category)
      updated.push(key)
    }
  })
  txn()

  logAuditEvent({
    action: 'edge_tray_config_import',
    actor: 'edge-tray',
    detail: { keys: updated, bridge_reconnect: shouldReconnectBridge },
  })

  if (shouldReconnectBridge) {
    restartRemoteBridge()
  }

  return NextResponse.json({ ok: true, updated })
}
