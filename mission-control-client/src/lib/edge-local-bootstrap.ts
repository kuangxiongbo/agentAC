import { createHash } from 'node:crypto'
import os from 'node:os'
import { getDatabase } from '@/lib/db'

export type EdgeBootstrapPayload = {
  schema: number
  center_url: string
  enterprise: { name: string; slug: string; tenant_id: number | null }
  client: { client_id: string; client_name: string; hostname: string }
  bridge: { server_url: string; token: string }
  runtime_manifest: null
  settings: Record<string, string>
}

function getSetting(db: ReturnType<typeof getDatabase>, key: string, fallback = ''): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined
  const value = typeof row?.value === 'string' ? row.value.trim() : ''
  return value || fallback
}

function sanitizeClientName(hostname: string): string {
  let name = String(hostname || '').trim()
  if (!name) return 'Edge-Client'
  name = name.replace(/\.local$/i, '').replace(/\.lan$/i, '')
  name = name.replace(/[^\w.\-@]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
  return name.slice(0, 64) || 'Edge-Client'
}

function stableClientId(deviceId: string, enrollToken: string, hostname: string): string {
  const trimmed = deviceId.trim()
  if (/^mc-edge-[a-z0-9-]+$/i.test(trimmed)) {
    return trimmed
  }
  const seed = `${enrollToken}:${deviceId || hostname}`
  const hash = createHash('sha256').update(seed).digest('hex').slice(0, 12)
  return `mc-edge-${hash}`
}

/** Build bootstrap from local Web client settings when center API is unreachable or not deployed. */
export function buildLocalEdgeBootstrap(input: {
  hostname?: string
  deviceId?: string
}): { payload: EdgeBootstrapPayload } | { error: string; status: number } {
  const db = getDatabase()
  const centerUrl = getSetting(db, 'gateway.server_url')
  const gatewayToken = getSetting(db, 'gateway.token')
  const enrollToken = getSetting(db, 'edge.enroll_token') || gatewayToken
  if (!centerUrl) {
    return { error: 'gateway.server_url is not configured on this client', status: 503 }
  }
  if (!enrollToken) {
    return { error: 'gateway.token / edge.enroll_token is not configured', status: 503 }
  }

  const hostname = (input.hostname || os.hostname() || 'edge-client').trim()
  const configuredName = getSetting(db, 'gateway.client_name')
  const clientName = configuredName || sanitizeClientName(hostname)
  const deviceSeed = (input.deviceId || getSetting(db, 'device.client_id')).trim() || hostname
  const clientId = stableClientId(deviceSeed, enrollToken, hostname)
  const enterpriseName = getSetting(db, 'edge.enterprise_name', 'E-Agent Enterprise')
  const enterpriseSlug = getSetting(db, 'edge.enterprise_slug', 'default')
  const tenantId = getSetting(db, 'edge.tenant_id')

  const settings: Record<string, string> = {
    'gateway.server_url': centerUrl.replace(/\/+$/, ''),
    'gateway.token': gatewayToken || enrollToken,
    'edge.enroll_token': enrollToken,
    'gateway.client_name': clientName,
    'device.client_id': clientId,
    'edge.enterprise_name': enterpriseName,
    'edge.enterprise_slug': enterpriseSlug,
    'edge.hostname': hostname,
    'edge.enrolled_at': String(Math.floor(Date.now() / 1000)),
    'general.server_gateway_sync': 'true',
  }
  if (tenantId) {
    settings['edge.tenant_id'] = tenantId
  }

  return {
    payload: {
      schema: 1,
      center_url: centerUrl.replace(/\/+$/, ''),
      enterprise: { name: enterpriseName, slug: enterpriseSlug, tenant_id: tenantId ? Number(tenantId) : null },
      client: { client_id: clientId, client_name: clientName, hostname },
      bridge: { server_url: centerUrl.replace(/\/+$/, ''), token: gatewayToken || enrollToken },
      runtime_manifest: null,
      settings,
    },
  }
}
