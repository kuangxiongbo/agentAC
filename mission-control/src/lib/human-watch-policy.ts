import type Database from 'better-sqlite3'
import { getDatabase } from './db'
import { hasEntitlement, resolveEffectiveLicense } from './effective-license'
import { getProviderSubjectForUser } from './license-resolve-context'

function dbOr(database?: Database.Database): Database.Database {
  return database ?? getDatabase()
}

function envHumanWatchOverride(): boolean {
  const flag = String(process.env.MC_HUMAN_WATCH_ENABLED || '').trim().toLowerCase()
  return flag === '1' || flag === 'true' || flag === 'yes'
}

/** Tenant-level human watch feature gate (center authority). */
export function isHumanWatchEnabledForTenant(
  tenantId: number,
  database?: Database.Database,
): boolean {
  if (envHumanWatchOverride()) return true
  if (!Number.isFinite(tenantId) || tenantId < 1) return false

  const db = dbOr(database)
  const row = db
    .prepare(`SELECT human_watch_enabled FROM tenants WHERE id = ? LIMIT 1`)
    .get(tenantId) as { human_watch_enabled?: number } | undefined
  return Boolean(row?.human_watch_enabled)
}

export function setHumanWatchEnabledForTenant(
  tenantId: number,
  enabled: boolean,
  database?: Database.Database,
): void {
  const db = dbOr(database)
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    `UPDATE tenants SET human_watch_enabled = ?, updated_at = ? WHERE id = ?`,
  ).run(enabled ? 1 : 0, now, tenantId)
}

export type HumanWatchAvailability = {
  /** 是否可使用人工值守（创建值守、绑定等） */
  available: boolean
  /** 用户中心订阅权益 enableHumanWatch */
  subscriptionEntitled: boolean
  /** 租户表 human_watch_enabled（历史开关，可与订阅并存） */
  tenantFlag: boolean
  envOverride: boolean
}

export async function resolveHumanWatchAvailability(
  tenantId: number,
  userId?: number,
  portalTenantRole?: string | null,
  database?: Database.Database,
): Promise<HumanWatchAvailability> {
  const envOverride = envHumanWatchOverride()
  const tenantFlag = isHumanWatchEnabledForTenant(tenantId, database)
  const license = await resolveEffectiveLicense({
    tenantId,
    zitadelSub: userId ? getProviderSubjectForUser(userId) : null,
    portalTenantRole,
  })
  const subscriptionEntitled = hasEntitlement(license, 'enableHumanWatch')
  const available = envOverride || subscriptionEntitled || tenantFlag
  return { available, subscriptionEntitled, tenantFlag, envOverride }
}

export type HumanWatchPolicyResult =
  | { ok: true }
  | { ok: false; error: string; status: number; code?: 'subscription_required' | 'tenant_disabled' }

export async function requireHumanWatchEntitlement(
  tenantId: number,
  userId?: number,
  portalTenantRole?: string | null,
  database?: Database.Database,
): Promise<HumanWatchPolicyResult> {
  const state = await resolveHumanWatchAvailability(tenantId, userId, portalTenantRole, database)
  if (state.available) return { ok: true }
  if (!state.subscriptionEntitled) {
    return {
      ok: false,
      error: 'Human watch subscription required',
      status: 402,
      code: 'subscription_required',
    }
  }
  return {
    ok: false,
    error: 'Human watch is not enabled for this tenant',
    status: 403,
    code: 'tenant_disabled',
  }
}

export function requireHumanWatchEnabled(
  tenantId: number,
  database?: Database.Database,
): HumanWatchPolicyResult {
  if (isHumanWatchEnabledForTenant(tenantId, database)) {
    return { ok: true }
  }
  return {
    ok: false,
    error: 'Human watch is not enabled for this tenant',
    status: 403,
  }
}
