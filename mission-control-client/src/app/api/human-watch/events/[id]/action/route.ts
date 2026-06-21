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

type RouteContext = {
  params: Promise<{ id: string }>
}

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = requireRole(request, 'operator')
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

  const bodyText = await request.text()
  const { id } = await context.params
  const eventId = String(id || '').trim()
  if (!eventId) {
    return NextResponse.json({ error: 'event id is required' }, { status: 400 })
  }

  const base = upstream.baseUrl.replace(/\/+$/, '')
  const url = `${base}/api/human-watch/events/${encodeURIComponent(eventId)}/action`
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'x-api-key': token,
    'Content-Type': request.headers.get('content-type') || 'application/json',
  }

  try {
    const res = await edgeUpstreamFetch(url, {
      method: 'POST',
      headers,
      cache: 'no-store',
      body: bodyText,
    })
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
        ...(body && typeof body === 'object' ? body : {}),
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
