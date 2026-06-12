import { LICENSE_SCHEMA_SETTINGS } from './license-schema-meta'
import { LICENSE_ENTITLEMENT_META_LIST } from './license-schema-meta'
import { getLicenseSetting, LICENSE_CENTER_URL_KEY } from './license-settings-store'

function fallbackStage(): string {
  const raw = String(process.env.NODE_ENV || '').trim().toLowerCase()
  return raw === 'production' ? 'prod' : 'local'
}

export const LICENSE_APP_ID =
  String(process.env.LICENSE_APP_ID || '').trim() ||
  String(LICENSE_SCHEMA_SETTINGS.appId || '').trim() ||
  'mission-control'

export const OIDC_INSTANCE_CLIENT_ID = String(
  process.env.ZITADEL_CLIENT_ID || process.env.OIDC_CLIENT_ID || '',
).trim()

export const OIDC_APPLICATION_ID = String(process.env.OIDC_APPLICATION_ID || '').trim()
export const APP_STAGE =
  String(process.env.APP_STAGE || '').trim().toLowerCase() || fallbackStage()

export type MissionControlEntitlements = {
  enableHumanWatch: boolean
  enableLocalCliElevation: boolean
  [key: string]: unknown
}

function coerceEntitlementValue(value: unknown, type: 'boolean' | 'number' | 'string', defaultValue: unknown): unknown {
  if (type === 'number') {
    const n = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(n) ? n : defaultValue
  }
  if (type === 'string') {
    return typeof value === 'string' ? value : defaultValue
  }
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'y', 'on', '是'].includes(normalized)) return true
    if (['false', '0', 'no', 'n', 'off', '否'].includes(normalized)) return false
  }
  return Boolean(defaultValue)
}

function buildDefaultEntitlements(): MissionControlEntitlements {
  const out: Record<string, unknown> = {
    enableHumanWatch: false,
    enableLocalCliElevation: false,
  }
  for (const item of LICENSE_ENTITLEMENT_META_LIST) {
    out[item.key] = item.defaultValue
  }
  return out as MissionControlEntitlements
}

function mergeVerifiedEntitlements(overrides?: Record<string, unknown> | null): MissionControlEntitlements {
  const base = buildDefaultEntitlements()
  const input = overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {}
  const merged: Record<string, unknown> = { ...base, ...input }
  for (const item of LICENSE_ENTITLEMENT_META_LIST) {
    merged[item.key] = coerceEntitlementValue(merged[item.key], item.type, item.defaultValue)
  }
  merged.enableHumanWatch = Boolean(merged.enableHumanWatch)
  merged.enableLocalCliElevation = Boolean(merged.enableLocalCliElevation)
  return merged as MissionControlEntitlements
}

export type VerifyResult = {
  licensed: boolean
  reason?: 'unsubscribed' | 'expired' | 'error' | 'app_instance_mismatch'
  entitlements: MissionControlEntitlements
  expiresAt?: string | null
}

const cache = new Map<string, { result: VerifyResult; expiresAt: number }>()
const CACHE_TTL_MS = 60_000

function pruneCache() {
  const now = Date.now()
  for (const [k, v] of cache) {
    if (v.expiresAt < now) cache.delete(k)
  }
}

function resolveUserCenterApiUrl(): string {
  const stored = getLicenseSetting(LICENSE_CENTER_URL_KEY)
  const fromDb = stored != null ? String(stored).trim() : ''
  const fromEnv = String(process.env.USER_CENTER_API_URL || process.env.USERCENTER_ORIGIN || '').trim()
  return (fromDb || fromEnv).replace(/\/$/, '')
}

export function verifyLicense(zitadelSub: string, tenantId?: string): Promise<VerifyResult> {
  const userCenterApiUrl = resolveUserCenterApiUrl()
  const userCenterInternalSecret = String(process.env.USER_CENTER_INTERNAL_SECRET || '').trim()

  if (!userCenterApiUrl) {
    return Promise.resolve({
      licensed: true,
      entitlements: mergeVerifiedEntitlements({ enableHumanWatch: true, enableLocalCliElevation: true }),
      expiresAt: null,
    })
  }

  const cacheKey = tenantId || zitadelSub
  pruneCache()
  const cached = cache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return Promise.resolve(cached.result)
  }

  return fetch(`${userCenterApiUrl}/api/internal/verify-access`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(userCenterInternalSecret ? { 'X-Internal-Secret': userCenterInternalSecret } : {}),
    },
    body: JSON.stringify({
      app_id: LICENSE_APP_ID,
      client_id: LICENSE_APP_ID,
      subject: zitadelSub,
      oidc_client_id: OIDC_INSTANCE_CLIENT_ID || null,
      application_id: OIDC_APPLICATION_ID || null,
      stage: APP_STAGE || null,
    }),
    signal: AbortSignal.timeout(8000),
  })
    .then(async (resp) => {
      if (!resp.ok) {
        return { licensed: false, reason: 'error' as const, entitlements: mergeVerifiedEntitlements() }
      }
      const data = (await resp.json()) as {
        licensed?: boolean
        reason?: string
        license?: { entitlements?: Partial<MissionControlEntitlements>; expiresAt?: string | null }
      }
      const result: VerifyResult = {
        licensed: Boolean(data.licensed),
        reason: data.reason as VerifyResult['reason'],
        entitlements: mergeVerifiedEntitlements(data.license?.entitlements),
        expiresAt: data.license?.expiresAt ?? null,
      }
      cache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS })
      return result
    })
    .catch(() => ({
      licensed: false,
      reason: 'error' as const,
      entitlements: mergeVerifiedEntitlements(),
    }))
}

export function invalidateLicenseCache(tenantId: string) {
  cache.delete(tenantId)
}
