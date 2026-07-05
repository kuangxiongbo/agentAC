import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { edgeUpstreamFetch, formatUpstreamFetchError } from '@/lib/edge-upstream-fetch'
import { getRemoteBridgeStatus, getRemoteUpstreamConfig } from '@/lib/remote-server-bridge'
import { getDatabase } from '@/lib/db'

export const dynamic = 'force-dynamic'

function getSetting(db: ReturnType<typeof getDatabase>, key: string, fallback = ''): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined
  const value = typeof row?.value === 'string' ? row.value.trim() : ''
  return value || fallback
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  const upstream = getRemoteUpstreamConfig()
  if (!upstream.baseUrl) {
    return NextResponse.json({ error: 'gateway.server_url is not configured on this client' }, { status: 503 })
  }

  const db = getDatabase()
  const token = getSetting(db, 'gateway.token')
  if (!token) {
    return NextResponse.json({ error: 'gateway.token is not configured on this client' }, { status: 503 })
  }

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const base = upstream.baseUrl.replace(/\/+$/, '')
  const bridge = getRemoteBridgeStatus()
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'x-api-key': token,
    'Content-Type': 'application/json',
  }

  try {
    const res = await edgeUpstreamFetch(`${base}/api/human-watch/assist`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      cache: 'no-store',
    })
    const text = await res.text()
    let payload: Record<string, unknown>
    try {
      payload = text ? JSON.parse(text) : {}
    } catch {
      payload = { raw: text }
    }
    return NextResponse.json({
      ...payload,
      proxy_meta: {
        via: 'web-client',
        bridge_connected: bridge.connected,
        bridge_enabled: bridge.enabled,
        upstream_url: upstream.baseUrl,
      },
    }, { status: res.status })
  } catch (err) {
    return NextResponse.json({ error: formatUpstreamFetchError(err) }, { status: 502 })
  }
}
