import { getDatabase } from '@/lib/db'
import { edgeUpstreamFetch, formatUpstreamFetchError } from '@/lib/edge-upstream-fetch'
import { getRemoteUpstreamConfig } from '@/lib/remote-server-bridge'

function getSetting(key: string): string {
  const row = getDatabase().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined
  return typeof row?.value === 'string' ? row.value.trim() : ''
}

export async function proxySupervisionWorkerRequest(
  route: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const upstream = getRemoteUpstreamConfig()
  if (!upstream.baseUrl) {
    return { status: 503, body: { error: 'gateway.server_url is not configured on this client' } }
  }
  const token = getSetting('gateway.token')
  if (!token) {
    return { status: 503, body: { error: 'gateway.token is not configured on this client' } }
  }
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  headers.set('authorization', `Bearer ${token}`)
  headers.set('x-api-key', token)
  if (init.body) headers.set('content-type', 'application/json')

  try {
    const response = await edgeUpstreamFetch(
      `${upstream.baseUrl.replace(/\/+$/, '')}${route}`,
      { ...init, headers, cache: 'no-store' },
    )
    const text = await response.text()
    let body: unknown
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = { raw: text }
    }
    return { status: response.status, body }
  } catch (error) {
    return { status: 502, body: { error: formatUpstreamFetchError(error) } }
  }
}
