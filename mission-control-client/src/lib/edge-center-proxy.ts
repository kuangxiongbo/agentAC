import os from 'node:os'
import { getDatabase } from '@/lib/db'
import { buildLocalEdgeBootstrap } from '@/lib/edge-local-bootstrap'
import { edgeUpstreamFetch, formatUpstreamFetchError } from '@/lib/edge-upstream-fetch'
import { getRemoteBridgeStatus, getRemoteUpstreamConfig } from '@/lib/remote-server-bridge'

function getSetting(db: ReturnType<typeof getDatabase>, key: string, fallback = ''): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined
  const value = typeof row?.value === 'string' ? row.value.trim() : ''
  return value || fallback
}

export type EdgeCenterProxyMeta = {
  via: 'web-client'
  bridge_connected: boolean
  bridge_enabled: boolean
  upstream_url: string
}

function isEdgeBootstrapJson(body: unknown): body is { schema?: number } {
  return typeof body === 'object' && body !== null && 'schema' in body && (body as { schema?: number }).schema === 1
}

function localBootstrapMeta(
  upstreamUrl: string,
  bridge: ReturnType<typeof getRemoteBridgeStatus>,
  reason: string,
): EdgeCenterProxyMeta & { fallback_reason?: string } {
  return {
    via: 'web-client',
    bridge_connected: bridge.connected,
    bridge_enabled: bridge.enabled,
    upstream_url: upstreamUrl,
    fallback_reason: reason,
  }
}

/** Forward edge bootstrap through the same upstream config + token as Bridge (5101 → center). */
export async function fetchCenterBootstrapViaWebClient(input: {
  hostname?: string
  deviceId?: string
}): Promise<{ payload: unknown; meta: EdgeCenterProxyMeta } | { error: string; status: number }> {
  const upstream = getRemoteUpstreamConfig()
  if (!upstream.baseUrl) {
    return { error: 'gateway.server_url is not configured on this client', status: 503 }
  }

  const db = getDatabase()
  const gatewayToken = getSetting(db, 'gateway.token')
  const enrollToken = getSetting(db, 'edge.enroll_token') || gatewayToken
  if (!enrollToken) {
    return { error: 'gateway.token / edge.enroll_token is not configured', status: 503 }
  }

  const bridge = getRemoteBridgeStatus()
  const hostname = (input.hostname || os.hostname() || 'edge-client').trim()
  const deviceId = (input.deviceId || getSetting(db, 'device.client_id')).trim()
  const base = upstream.baseUrl.replace(/\/+$/, '')
  const qs = new URLSearchParams({ hostname })
  if (deviceId) qs.set('device_id', deviceId)

  const url = `${base}/api/edge/bootstrap?${qs.toString()}`
  const headers: Record<string, string> = {
    'x-edge-enroll-token': enrollToken,
    'x-api-key': enrollToken,
    Authorization: `Bearer ${enrollToken}`,
  }

  try {
    const res = await edgeUpstreamFetch(url, { headers, cache: 'no-store' })
    const text = await res.text()
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }
    if (res.ok && isEdgeBootstrapJson(body)) {
      return {
        payload: body,
        meta: {
          via: 'web-client',
          bridge_connected: bridge.connected,
          bridge_enabled: bridge.enabled,
          upstream_url: upstream.baseUrl,
        },
      }
    }
    const reason =
      typeof body === 'object' && body && 'error' in body
        ? String((body as { error?: string }).error)
        : res.ok
          ? 'center returned non-JSON bootstrap (API not deployed?)'
          : `Center bootstrap HTTP ${res.status}`
    const local = buildLocalEdgeBootstrap({ hostname, deviceId })
    if ('payload' in local) {
      return {
        payload: local.payload,
        meta: localBootstrapMeta(upstream.baseUrl, bridge, reason),
      }
    }
    return { error: reason, status: res.status >= 400 ? res.status : 502 }
  } catch (e) {
    const reason = formatUpstreamFetchError(e)
    const local = buildLocalEdgeBootstrap({ hostname, deviceId })
    if ('payload' in local) {
      return {
        payload: local.payload,
        meta: localBootstrapMeta(upstream.baseUrl, bridge, reason),
      }
    }
    return {
      error: `Failed to reach center via web client upstream: ${reason}`,
      status: 502,
    }
  }
}

export async function fetchCenterRuntimeManifestViaWebClient(): Promise<
  { manifest: unknown; meta: EdgeCenterProxyMeta } | { error: string; status: number }
> {
  const upstream = getRemoteUpstreamConfig()
  if (!upstream.baseUrl) {
    return { error: 'gateway.server_url is not configured', status: 503 }
  }
  const db = getDatabase()
  const enrollToken = getSetting(db, 'edge.enroll_token') || getSetting(db, 'gateway.token')
  if (!enrollToken) {
    return { error: 'gateway.token is not configured', status: 503 }
  }
  const bridge = getRemoteBridgeStatus()
  const base = upstream.baseUrl.replace(/\/+$/, '')
  const url = `${base}/api/releases/edge-runtime-manifest`
  const headers: Record<string, string> = {
    'x-edge-enroll-token': enrollToken,
    'x-api-key': enrollToken,
    Authorization: `Bearer ${enrollToken}`,
  }
  try {
    const res = await edgeUpstreamFetch(url, { headers, cache: 'no-store' })
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      const message =
        typeof body === 'object' && body && 'error' in body
          ? String((body as { error?: string }).error)
          : `Manifest HTTP ${res.status}`
      return { error: message, status: res.status }
    }
    return {
      manifest: body,
      meta: {
        via: 'web-client',
        bridge_connected: bridge.connected,
        bridge_enabled: bridge.enabled,
        upstream_url: upstream.baseUrl,
      },
    }
  } catch (e) {
    return { error: formatUpstreamFetchError(e), status: 502 }
  }
}
