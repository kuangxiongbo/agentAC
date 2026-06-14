import { createHash, randomUUID } from 'node:crypto'
import { getDatabase } from '@/lib/db'
import type { User } from '@/lib/auth'
import {
  loadEdgeRuntimeManifest,
  resolveManifestPublicUrls,
  type EdgeRuntimeManifest,
} from '@/lib/edge-runtime-manifest'

export type { EdgeRuntimeManifest }

export type EdgeBootstrapPayload = {
  schema: number
  center_url: string
  enterprise: {
    name: string
    slug: string
    tenant_id: number | null
  }
  client: {
    client_id: string
    client_name: string
    hostname: string
  }
  bridge: {
    server_url: string
    token: string
  }
  runtime_manifest: EdgeRuntimeManifest | null
  settings: Record<string, string>
}

function loadRuntimeManifest(centerUrl: string): EdgeRuntimeManifest | null {
  const raw = loadEdgeRuntimeManifest()
  if (!raw) return null
  return resolveManifestPublicUrls(raw, centerUrl)
}

function resolveActiveApiKey(): string {
  try {
    const db = getDatabase()
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'security.api_key'")
      .get() as { value?: string } | undefined
    if (row?.value?.trim()) return row.value.trim()
  } catch {
    // ignore
  }
  return (process.env.API_KEY || '').trim()
}

export type EnrollTokenSource = 'session' | 'env' | 'api_key' | 'bridge' | 'multi' | 'none'

export type ScopedEnrollTokenClaims = {
  v: 1
  typ: 'edge-enroll'
  uid: number
  tid: number
  wid: number
  iat: number
  exp: number
}

type TokenValidation =
  | { valid: true; scope?: ScopedEnrollTokenClaims }
  | { valid: false }

function resolveTokenSigningSecret(): string {
  return (
    (process.env.MC_EDGE_ENROLL_SIGNING_SECRET || '').trim() ||
    (process.env.AUTH_SECRET || '').trim() ||
    resolveActiveApiKey() ||
    (process.env.MC_EDGE_BRIDGE_TOKEN || '').trim()
  )
}

function signScopedClaims(claims: ScopedEnrollTokenClaims, secret: string): string {
  return createHash('sha256')
    .update(`${JSON.stringify(claims)}:${secret}`)
    .digest('base64url')
}

export function createScopedDistributionEnrollToken(user: Pick<User, 'id' | 'tenant_id' | 'workspace_id'>): string {
  const secret = resolveTokenSigningSecret()
  if (!secret) return ''
  const now = Math.floor(Date.now() / 1000)
  const claims: ScopedEnrollTokenClaims = {
    v: 1,
    typ: 'edge-enroll',
    uid: user.id,
    tid: user.tenant_id,
    wid: user.workspace_id,
    iat: now,
    exp: now + 30 * 24 * 60 * 60,
  }
  const encoded = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
  return `mcet_${encoded}.${signScopedClaims(claims, secret)}`
}

export function validateScopedDistributionEnrollToken(token: string): ScopedEnrollTokenClaims | null {
  if (!token.startsWith('mcet_')) return null
  const secret = resolveTokenSigningSecret()
  if (!secret) return null
  const raw = token.slice('mcet_'.length)
  const dot = raw.lastIndexOf('.')
  if (dot <= 0) return null
  const encoded = raw.slice(0, dot)
  const sig = raw.slice(dot + 1)
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<ScopedEnrollTokenClaims>
    if (parsed.v !== 1 || parsed.typ !== 'edge-enroll') return null
    if (
      typeof parsed.uid !== 'number' ||
      typeof parsed.tid !== 'number' ||
      typeof parsed.wid !== 'number' ||
      typeof parsed.iat !== 'number' ||
      typeof parsed.exp !== 'number'
    ) {
      return null
    }
    const claims = parsed as ScopedEnrollTokenClaims
    if (claims.exp < Math.floor(Date.now() / 1000)) return null
    if (signScopedClaims(claims, secret) !== sig) return null
    return claims
  } catch {
    return null
  }
}

/** Token shown on /edge/download — matches what Edge bootstrap accepts. */
export function resolveDistributionEnrollToken(user?: Pick<User, 'id' | 'tenant_id' | 'workspace_id'>): {
  token: string
  source: EnrollTokenSource
  multiTokens?: string[]
} {
  if (user?.id && user.tenant_id && user.workspace_id) {
    const scoped = createScopedDistributionEnrollToken(user)
    if (scoped) return { token: scoped, source: 'session' }
  }

  const single = (process.env.MC_EDGE_ENROLL_TOKEN || '').trim()
  if (single) return { token: single, source: 'env' }

  const mapRaw = (process.env.MC_EDGE_ENROLL_TOKENS || '').trim()
  if (mapRaw) {
    try {
      const map = JSON.parse(mapRaw) as Record<string, unknown>
      const keys = Object.keys(map).map((k) => k.trim()).filter(Boolean)
      if (keys.length === 1) return { token: keys[0], source: 'env' }
      if (keys.length > 1) return { token: keys[0], source: 'multi', multiTokens: keys }
    } catch {
      // ignore
    }
  }

  const allowApiKey =
    process.env.MC_EDGE_ENROLL_ALLOW_API_KEY !== '0' &&
    (process.env.MC_EDGE_ENROLL_ALLOW_API_KEY === '1' ||
      !(process.env.MC_EDGE_ENROLL_TOKEN || '').trim())

  if (allowApiKey) {
    const apiKey = resolveActiveApiKey()
    if (apiKey) return { token: apiKey, source: 'api_key' }
  }

  const bridgeToken = (process.env.MC_EDGE_BRIDGE_TOKEN || '').trim()
  if (bridgeToken) return { token: bridgeToken, source: 'bridge' }

  return { token: '', source: 'none' }
}

function validateEnrollToken(token: string): TokenValidation {
  if (!token) return { valid: false }
  const scoped = validateScopedDistributionEnrollToken(token)
  if (scoped) return { valid: true, scope: scoped }
  const single = (process.env.MC_EDGE_ENROLL_TOKEN || '').trim()
  if (single && token === single) return { valid: true }
  const mapRaw = (process.env.MC_EDGE_ENROLL_TOKENS || '').trim()
  if (mapRaw) {
    try {
      const map = JSON.parse(mapRaw) as Record<string, string>
      if (Object.prototype.hasOwnProperty.call(map, token)) return { valid: true }
    } catch {
      // ignore
    }
  }
  const apiKey = resolveActiveApiKey()
  const allowApiKey =
    process.env.MC_EDGE_ENROLL_ALLOW_API_KEY !== '0' &&
    (process.env.MC_EDGE_ENROLL_ALLOW_API_KEY === '1' ||
      !(process.env.MC_EDGE_ENROLL_TOKEN || '').trim())
  if (allowApiKey && apiKey && token === apiKey) return { valid: true }
  const bridgeToken = (process.env.MC_EDGE_BRIDGE_TOKEN || '').trim() || apiKey
  if (bridgeToken && token === bridgeToken) return { valid: true }
  return { valid: false }
}

function resolveEnterpriseMeta(enrollToken: string): { name: string; slug: string; tenant_id: number | null } {
  const mapRaw = (process.env.MC_EDGE_ENROLL_TOKENS || '').trim()
  if (mapRaw) {
    try {
      const map = JSON.parse(mapRaw) as Record<string, { name?: string; slug?: string; tenant_id?: number }>
      const entry = map[enrollToken]
      if (entry) {
        const slug = String(entry.slug || 'default').trim() || 'default'
        const name = String(entry.name || entry.slug || 'Enterprise').trim() || 'Enterprise'
        const tenantId =
          typeof entry.tenant_id === 'number' && Number.isFinite(entry.tenant_id)
            ? entry.tenant_id
            : null
        return { name, slug, tenant_id: tenantId }
      }
    } catch {
      // ignore
    }
  }
  const name =
    (process.env.MC_EDGE_ENTERPRISE_NAME || process.env.MC_EDGE_ORGANIZATION_NAME || '').trim() ||
    'E-Agent Enterprise'
  const slug = (process.env.MC_EDGE_ENTERPRISE_SLUG || 'default').trim() || 'default'
  let tenantId: number | null = null
  const rawTenant = (process.env.MC_EDGE_TENANT_ID || '').trim()
  if (rawTenant && /^\d+$/.test(rawTenant)) {
    tenantId = parseInt(rawTenant, 10)
  }
  return { name, slug, tenant_id: tenantId }
}

function resolveTenantMetaById(tenantId: number): { name: string; slug: string; tenant_id: number | null } | null {
  try {
    const db = getDatabase()
    const row = db.prepare(`
      SELECT id, slug, display_name
      FROM tenants
      WHERE id = ?
      LIMIT 1
    `).get(tenantId) as { id?: number; slug?: string; display_name?: string } | undefined
    if (!row?.id) return null
    const slug = String(row.slug || `tenant-${row.id}`).trim() || `tenant-${row.id}`
    const name = String(row.display_name || row.slug || `Tenant ${row.id}`).trim() || `Tenant ${row.id}`
    return { name, slug, tenant_id: Number(row.id) }
  } catch {
    return null
  }
}

export function sanitizeClientName(hostname: string): string {
  let name = String(hostname || '').trim()
  if (!name) return 'Edge-Client'
  name = name.replace(/\.local$/i, '').replace(/\.lan$/i, '')
  name = name.replace(/[^\w.\-@]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
  return name.slice(0, 64) || 'Edge-Client'
}

function stableClientId(deviceId: string, enrollToken: string, hostname: string): string {
  const seed = `${enrollToken}:${deviceId || hostname}`
  const hash = createHash('sha256').update(seed).digest('hex').slice(0, 12)
  return `mc-edge-${hash}`
}

function resolveBridgeToken(): string {
  return (process.env.MC_EDGE_BRIDGE_TOKEN || '').trim() || resolveActiveApiKey()
}

export function buildEdgeBootstrap(input: {
  centerUrl: string
  enrollToken: string
  hostname: string
  deviceId?: string
}): { ok: true; payload: EdgeBootstrapPayload } | { ok: false; status: number; error: string } {
  const token = input.enrollToken.trim()
  const validation = validateEnrollToken(token)
  if (!validation.valid) {
    return { ok: false, status: 401, error: 'Invalid or missing edge enroll token' }
  }

  const centerUrl = input.centerUrl.replace(/\/+$/, '')
  const hostname = String(input.hostname || '').trim()
  const clientName = sanitizeClientName(hostname)
  const deviceSeed = String(input.deviceId || '').trim() || hostname || randomUUID()
  const clientId = stableClientId(deviceSeed, token, hostname)
  const bridgeToken = resolveBridgeToken()
  if (!bridgeToken) {
    return {
      ok: false,
      status: 503,
      error: 'Center bridge token not configured (set API_KEY or MC_EDGE_BRIDGE_TOKEN)',
    }
  }

  const enterprise =
    validation.scope && validation.scope.tid
      ? (resolveTenantMetaById(validation.scope.tid) || {
          name: `Tenant ${validation.scope.tid}`,
          slug: `tenant-${validation.scope.tid}`,
          tenant_id: validation.scope.tid,
        })
      : resolveEnterpriseMeta(token)
  if (enterprise.tenant_id == null) {
    try {
      const db = getDatabase()
      const row = db
        .prepare('SELECT id FROM tenants WHERE status = ? ORDER BY id ASC LIMIT 1')
        .get('active') as { id?: number } | undefined
      if (row?.id) enterprise.tenant_id = Number(row.id)
    } catch {
      // ignore
    }
  }

  const settings: Record<string, string> = {
    'gateway.server_url': centerUrl,
    'gateway.token': bridgeToken,
    'edge.enroll_token': token,
    'gateway.client_name': clientName,
    'device.client_id': clientId,
    'edge.enterprise_name': enterprise.name,
    'edge.enterprise_slug': enterprise.slug,
    'edge.hostname': hostname || clientName,
    'edge.enrolled_at': String(Math.floor(Date.now() / 1000)),
    'general.server_gateway_sync': 'true',
  }
  if (enterprise.tenant_id != null) {
    settings['edge.tenant_id'] = String(enterprise.tenant_id)
  }

  return {
    ok: true,
    payload: {
      schema: 1,
      center_url: centerUrl,
      enterprise,
      client: {
        client_id: clientId,
        client_name: clientName,
        hostname: hostname || clientName,
      },
      bridge: {
        server_url: centerUrl,
        token: bridgeToken,
      },
      runtime_manifest: loadRuntimeManifest(centerUrl),
      settings,
    },
  }
}
