import { createVerify } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  LICENSE_ENTITLEMENT_META_LIST,
  LICENSE_SCHEMA_SETTINGS,
} from './license-schema-meta'
import {
  getLicenseSetting,
  offlineLicenseSettingKey,
  setLicenseSetting,
} from './license-settings-store'
import {
  LICENSE_APP_ID,
  type MissionControlEntitlements,
  verifyLicense,
} from './license-verifier'

export type LicFile = {
  payload: {
    version: number
    clientId?: string
    appId?: string
    tenantId: string
    hardwareId: string | null
    entitlements: Record<string, unknown>
    issuedAt: string
    expiresAt: string
  }
  signature: string
  publicKey: string
}

export type EffectiveLicenseResult = {
  allowed: boolean
  licensed: boolean
  source: 'online' | 'offline' | 'default'
  reason?: 'unsubscribed' | 'expired' | 'error' | 'app_instance_mismatch' | 'user_not_found' | 'no_tenant'
  entitlements: MissionControlEntitlements
  expiresAt: string | null
  requiresSubscription: boolean
  appId: string
  displayName: string
}

function buildDefaultEntitlements(): MissionControlEntitlements {
  const out: Record<string, unknown> = { enableHumanWatch: false }
  for (const item of LICENSE_ENTITLEMENT_META_LIST) {
    out[item.key] = item.defaultValue
  }
  return out as MissionControlEntitlements
}

function mergeEntitlements(overrides?: Record<string, unknown> | null): MissionControlEntitlements {
  const base = buildDefaultEntitlements()
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return base
  }
  const merged = {
    ...base,
    ...overrides,
  } as MissionControlEntitlements
  merged.enableHumanWatch = Boolean(merged.enableHumanWatch)
  merged.enableLocalCliElevation = Boolean(merged.enableLocalCliElevation)
  return merged
}

export function licenseEnforcementDisabled(): boolean {
  const v = String(process.env.MC_LICENSE_ENFORCE || 'true').trim().toLowerCase()
  return v === '0' || v === 'false' || v === 'no'
}

function isLicenseBypassRole(portalTenantRole?: string | null): boolean {
  const role = String(portalTenantRole || '').trim().toLowerCase()
  return role === 'platform_admin' || role === 'super_admin' || role === 'platform_owner'
}

function loadOfflineLicense(tenantId: string, database?: Database.Database): LicFile | null {
  const raw = getLicenseSetting(offlineLicenseSettingKey(tenantId), database)
  if (!raw) return null
  try {
    return JSON.parse(raw) as LicFile
  } catch {
    return null
  }
}

export function verifyLicFile(lic: LicFile): { ok: true } | { ok: false; error: string } {
  try {
    const verify = createVerify('SHA256')
    verify.update(JSON.stringify(lic.payload))
    verify.end()
    const valid = verify.verify(lic.publicKey, lic.signature, 'base64')
    if (!valid) return { ok: false, error: 'invalid_signature' }

    const payloadAppId = String(lic.payload.appId || lic.payload.clientId || '').trim()
    if (payloadAppId !== LICENSE_APP_ID) {
      return { ok: false, error: 'client_mismatch' }
    }

    if (lic.payload.expiresAt !== 'never') {
      const exp = new Date(lic.payload.expiresAt)
      if (exp.getTime() < Date.now()) {
        return { ok: false, error: 'expired' }
      }
    }
    return { ok: true }
  } catch {
    return { ok: false, error: 'parse_error' }
  }
}

export function saveOfflineLicense(tenantId: string, lic: LicFile, database?: Database.Database): void {
  setLicenseSetting(
    offlineLicenseSettingKey(tenantId),
    JSON.stringify(lic),
    { category: 'license', description: 'Offline license file' },
    database,
  )
}

export function resolveUserCenterSubscriptionsUrl(): string {
  const portal = String(process.env.USER_CENTER_PORTAL_URL || '').trim().replace(/\/$/, '')
  if (portal) return `${portal}/subscriptions`
  const api = String(process.env.USER_CENTER_API_URL || process.env.USERCENTER_ORIGIN || '').trim().replace(/\/$/, '')
  if (api) {
    try {
      const u = new URL(api)
      return `${u.origin}/subscriptions`
    } catch {
      /* ignore */
    }
  }
  return 'https://user.1sheng.work/subscriptions'
}

export async function resolveEffectiveLicense(
  input: {
    tenantId?: number | null
    zitadelSub?: string | null
    portalTenantRole?: string | null
    forceRefresh?: boolean
  },
  database?: Database.Database,
): Promise<EffectiveLicenseResult> {
  const requiresSubscription = LICENSE_SCHEMA_SETTINGS.requiresSubscription === true
  const tenantId = String(input.tenantId ?? 1)
  const zitadelSub = String(input.zitadelSub || '').trim()

  if (licenseEnforcementDisabled() || isLicenseBypassRole(input.portalTenantRole)) {
    return {
      allowed: true,
      licensed: true,
      source: 'default',
      entitlements: mergeEntitlements({ enableHumanWatch: true, enableLocalCliElevation: true }),
      expiresAt: null,
      requiresSubscription: false,
      appId: LICENSE_SCHEMA_SETTINGS.appId || LICENSE_APP_ID,
      displayName: LICENSE_SCHEMA_SETTINGS.displayName || LICENSE_APP_ID,
    }
  }

  let onlineResult: Awaited<ReturnType<typeof verifyLicense>> | null = null
  if (zitadelSub) {
    onlineResult = await verifyLicense(zitadelSub, tenantId, { forceRefresh: input.forceRefresh })
  }

  const offline = loadOfflineLicense(tenantId, database)
  if (onlineResult?.licensed) {
    return {
      allowed: true,
      licensed: true,
      source: 'online',
      entitlements: mergeEntitlements(onlineResult.entitlements as Record<string, unknown>),
      expiresAt: onlineResult.expiresAt ?? null,
      requiresSubscription,
      appId: LICENSE_SCHEMA_SETTINGS.appId || LICENSE_APP_ID,
      displayName: LICENSE_SCHEMA_SETTINGS.displayName || LICENSE_APP_ID,
    }
  }

  const canUseOfflineFallback = !onlineResult || onlineResult.reason === 'error'
  if (canUseOfflineFallback && offline) {
    const checked = verifyLicFile(offline)
    if (checked.ok) {
      return {
        allowed: true,
        licensed: true,
        source: 'offline',
        entitlements: mergeEntitlements(offline.payload.entitlements),
        expiresAt: offline.payload.expiresAt !== 'never' ? offline.payload.expiresAt : null,
        requiresSubscription,
        appId: LICENSE_SCHEMA_SETTINGS.appId || LICENSE_APP_ID,
        displayName: LICENSE_SCHEMA_SETTINGS.displayName || LICENSE_APP_ID,
      }
    }
  }

  const blockedReason = onlineResult?.reason || 'unsubscribed'
  const allowByDefault = !requiresSubscription
  return {
    allowed: allowByDefault,
    licensed: false,
    source: 'default',
    reason: blockedReason,
    entitlements: mergeEntitlements(),
    expiresAt: null,
    requiresSubscription,
    appId: LICENSE_SCHEMA_SETTINGS.appId || LICENSE_APP_ID,
    displayName: LICENSE_SCHEMA_SETTINGS.displayName || LICENSE_APP_ID,
  }
}

export function hasEntitlement(
  license: EffectiveLicenseResult,
  key: keyof MissionControlEntitlements,
): boolean {
  if (!license.allowed) return false
  const value = license.entitlements[key]
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  return Boolean(value)
}
