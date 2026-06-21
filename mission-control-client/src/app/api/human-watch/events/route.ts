import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { edgeUpstreamFetch, formatUpstreamFetchError } from '@/lib/edge-upstream-fetch'
import { getRemoteBridgeStatus, getRemoteUpstreamConfig } from '@/lib/remote-server-bridge'
import { getDatabase } from '@/lib/db'

function getSetting(db: ReturnType<typeof getDatabase>, key: string, fallback = ''): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined
  const value = typeof row?.value === 'string' ? row.value.trim() : ''
  return value || fallback
}

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const upstream = getRemoteUpstreamConfig()
  if (!upstream.baseUrl) {
    return NextResponse.json({ error: 'gateway.server_url is not configured on this client' }, { status: 503 })
  }

  const db = getDatabase()
  const token = getSetting(db, 'gateway.token')
  if (!token) {
    return NextResponse.json({ error: 'gateway.token is not configured on this client' }, { status: 503 })
  }

  const incoming = new URL(request.url)
  const base = upstream.baseUrl.replace(/\/+$/, '')
  const url = `${base}/api/human-watch/events${incoming.search || ''}`
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'x-api-key': token,
  }

  try {
    const res = await edgeUpstreamFetch(url, { headers, cache: 'no-store' })
    const text = await res.text()
    let body: any = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = { raw: text }
    }
    const bridge = getRemoteBridgeStatus()
    return NextResponse.json(
      {
        ...(body && typeof body === 'object' ? body : { events: [] }),
        proxy_meta: {
          via: 'web-client',
          bridge_connected: bridge.connected,
          bridge_enabled: bridge.enabled,
          upstream_url: upstream.baseUrl,
        },
      },
      { status: res.status },
    )
  } catch (err) {
    return NextResponse.json({ error: formatUpstreamFetchError(err) }, { status: 502 })
  }
}
