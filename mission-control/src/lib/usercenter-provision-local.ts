/**
 * 用户中心已确认 `hasTenant` 时，将租户上下文投影到 Mission Control 本地 SQLite
 *（对齐奕升 `1sheng-console/server/auth/loginService.ts` 中 `ensureLocalProjectionFromPortalContext` 的职责）。
 *
 * 仅在配置了 `USER_CENTER_API_URL` 且 OIDC 回调已拿到用户中心 `tenant` 对象时调用。
 */

import { randomBytes } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { getDatabase } from '@/lib/db'
import { createUser, updateUser, type User } from '@/lib/auth'
import { mapUsercenterTenantRoleToMcRole } from './usercenter-tenant-role-map'
import { slugFromOrganizationName } from './tenant-auth-scope'

export type UsercenterPortalTenant = {
  id: string
  name: string
  slug: string
  role: string
}

function sanitizeSlug(raw: string, fallback: string): string {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return s || fallback
}

export { mapUsercenterTenantRoleToMcRole }

function allocateUniqueTenantSlug(db: Database, base: string): string {
  let candidate = base.slice(0, 48)
  for (let i = 0; i < 24; i++) {
    const row = db.prepare('SELECT 1 as ok FROM tenants WHERE lower(slug) = lower(?) LIMIT 1').get(candidate) as { ok?: number } | undefined
    if (!row?.ok) return candidate
    candidate = `${base.slice(0, 32)}-${randomBytes(2).toString('hex')}`
  }
  return `uc-${randomBytes(6).toString('hex')}`.slice(0, 48)
}

function allocateUniqueWorkspaceSlug(db: Database, base: string): string {
  let candidate = base.slice(0, 64)
  for (let i = 0; i < 24; i++) {
    const row = db.prepare('SELECT 1 as ok FROM workspaces WHERE lower(slug) = lower(?) LIMIT 1').get(candidate) as { ok?: number } | undefined
    if (!row?.ok) return candidate
    candidate = `${base.slice(0, 48)}-${randomBytes(2).toString('hex')}`
  }
  return `ws-${randomBytes(6).toString('hex')}`.slice(0, 64)
}

function resolveOwnerGateway(db: Database): string {
  try {
    const hasGw = db.prepare(`SELECT 1 as ok FROM sqlite_master WHERE type='table' AND name='gateways'`).get() as { ok?: number } | undefined
    if (hasGw?.ok) {
      const row = db.prepare('SELECT name FROM gateways ORDER BY is_primary DESC, id ASC LIMIT 1').get() as { name?: string } | undefined
      if (row?.name?.trim()) return row.name.trim()
    }
  } catch {
    // ignore
  }
  return String(process.env.MC_DEFAULT_OWNER_GATEWAY || process.env.MC_DEFAULT_GATEWAY_NAME || 'primary').trim() || 'primary'
}

function findExistingTenantId(db: Database, portal: UsercenterPortalTenant): number | null {
  const ucId = String(portal.id || '').trim()
  if (/^\d+$/.test(ucId)) {
    const idNum = parseInt(ucId, 10)
    const byId = db.prepare('SELECT id FROM tenants WHERE id = ? LIMIT 1').get(idNum) as { id?: number } | undefined
    if (byId?.id) return Number(byId.id)
  }
  const slug = sanitizeSlug(portal.slug, sanitizeSlug(portal.id, 'tenant'))
  const bySlug = db.prepare('SELECT id FROM tenants WHERE lower(slug) = lower(?) LIMIT 1').get(slug) as { id?: number } | undefined
  if (bySlug?.id) return Number(bySlug.id)
  return null
}

function insertTenantForPortal(db: Database, portal: UsercenterPortalTenant): number {
  const slug = allocateUniqueTenantSlug(db, sanitizeSlug(portal.slug, sanitizeSlug(portal.id, 'tenant')))
  const displayName = String(portal.name || '').trim() || slug
  const linuxUser = `uc-${slug}-${randomBytes(3).toString('hex')}`.slice(0, 30)
  const home = String(process.env.HOME || '/tmp').trim() || '/tmp'
  const openclaw = `${home}/.openclaw`
  const workspaceRoot = `${home}/workspace`
  const ownerGateway = resolveOwnerGateway(db)
  const r = db
    .prepare(
      `INSERT INTO tenants (slug, display_name, linux_user, plan_tier, status, openclaw_home, workspace_root, config, created_by, owner_gateway)
       VALUES (?, ?, ?, 'standard', 'active', ?, ?, '{}', 'usercenter', ?)`
    )
    .run(slug, displayName, linuxUser, openclaw, workspaceRoot, ownerGateway)
  return Number(r.lastInsertRowid)
}

function ensureWorkspaceForTenant(db: Database, tenantId: number, portal: UsercenterPortalTenant): number {
  const existing = db
    .prepare('SELECT id FROM workspaces WHERE tenant_id = ? ORDER BY id ASC LIMIT 1')
    .get(tenantId) as { id?: number } | undefined
  if (existing?.id) return Number(existing.id)

  const baseSlug = allocateUniqueWorkspaceSlug(db, `ucw-${sanitizeSlug(portal.slug, 'ws')}`)
  const name = `${String(portal.name || '').trim() || 'Workspace'}`.slice(0, 128)
  const r = db
    .prepare(
      `INSERT INTO workspaces (slug, name, tenant_id, created_at, updated_at) VALUES (?, ?, ?, unixepoch(), unixepoch())`
    )
    .run(baseSlug, name, tenantId)
  return Number(r.lastInsertRowid)
}

/** Zitadel/Google 首次落库时的用户名派生（与租户投影共用）。 */
export function deriveZitadelLocalUsername(email: string, sub: string): string {
  const e = String(email || '')
    .trim()
    .toLowerCase()
  if (e.includes('@')) {
    const local = e.split('@')[0]?.replace(/[^a-z0-9._-]/g, '') || 'user'
    const domain = e.split('@')[1]?.replace(/[^a-z0-9.-]/g, '') || 'id'
    const candidate = `${local}_at_${domain}`.slice(0, 60)
    if (candidate.length >= 3) return candidate
  }
  const subSafe = String(sub || '')
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 40)
  return `zd_${subSafe || randomBytes(5).toString('hex')}`.slice(0, 60)
}

export type ProvisionFromUsercenterResult =
  | { ok: true; userId: number; workspaceId: number; tenantId: number; created: boolean }
  | { ok: false; error: string }

/** 按单位名称在本地确保租户/工作区存在，并将用户绑定到该工作区（无用户中心 id 时用 slug 对齐）。 */
export function ensureOrganizationBindingForUser(input: {
  userId: number
  organizationName: string
  role?: string
}): { tenantId: number; workspaceId: number } | null {
  const name = String(input.organizationName || '').trim()
  if (!name) return null

  const portal: UsercenterPortalTenant = {
    id: slugFromOrganizationName(name, 'org'),
    name,
    slug: slugFromOrganizationName(name, 'org'),
    role: String(input.role || 'member'),
  }

  return syncExistingUserWithUsercenterPortal({ userId: input.userId, portalTenant: portal })
}

/**
 * 已存在本地用户时，按用户中心租户上下文对齐：租户展示名、默认工作区、Mission Control 角色（创始人/负责人 → admin）。
 * 在 OIDC/Google 登录成功且 `tenant-context` 返回 `tenant` 时调用。
 */
export function syncExistingUserWithUsercenterPortal(input: {
  userId: number
  portalTenant: UsercenterPortalTenant
}): { tenantId: number; workspaceId: number; role: User['role'] } | null {
  const portal = input.portalTenant
  if (!String(portal.id || '').trim()) return null

  const db = getDatabase()
  try {
    return db.transaction(() => {
      let tenantId = findExistingTenantId(db, portal)
      if (tenantId == null) {
        tenantId = insertTenantForPortal(db, portal)
      } else {
        const dn = String(portal.name || '').trim()
        if (dn) {
          db.prepare('UPDATE tenants SET display_name = ? WHERE id = ?').run(dn.slice(0, 256), tenantId)
        }
      }
      const workspaceId = ensureWorkspaceForTenant(db, tenantId, portal)
      const portalName = String(portal.name || '').trim()
      if (portalName) {
        db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(portalName.slice(0, 128), workspaceId)
      }
      const role = mapUsercenterTenantRoleToMcRole(portal.role)
      const rawRole = String(portal.role || '').trim() || null
      updateUser(input.userId, { role, workspace_id: workspaceId, portal_tenant_role: rawRole })
      return { tenantId, workspaceId, role }
    })()
  } catch {
    return null
  }
}

/**
 * 在单连接事务内：解析 / 创建租户与工作区，并创建绑定 IdP sub 的本地用户（随机密码，不可用于本地密码登录）。
 */
export function provisionLocalUserFromUsercenterTenant(input: {
  sub: string
  email: string
  displayName: string
  portalTenant: UsercenterPortalTenant
  authProvider?: 'zitadel' | 'google'
}): ProvisionFromUsercenterResult {
  const db = getDatabase()
  const sub = String(input.sub || '').trim()
  if (!sub) return { ok: false, error: 'missing_sub' }

  const portal = input.portalTenant
  if (!String(portal.id || '').trim()) return { ok: false, error: 'missing_portal_tenant_id' }

  const password = randomBytes(32).toString('hex')
  const role = mapUsercenterTenantRoleToMcRole(portal.role)
  const displayName = String(input.displayName || '').trim() || String(portal.name || '').trim() || sub
  const emailNorm = String(input.email || '').trim().toLowerCase() || null

  try {
    let created = false
    const out = db.transaction(() => {
      let tenantId = findExistingTenantId(db, portal)
      if (tenantId == null) {
        tenantId = insertTenantForPortal(db, portal)
        created = true
      }
      const workspaceId = ensureWorkspaceForTenant(db, tenantId, portal)

      let username = deriveZitadelLocalUsername(emailNorm || '', sub)
      const authProvider = input.authProvider || 'zitadel'
      const tryCreate = (un: string) =>
        createUser(un, password, displayName, role, {
          provider: authProvider,
          provider_user_id: sub,
          email: emailNorm,
          is_approved: 1,
          workspace_id: workspaceId,
          portal_tenant_role: String(portal.role || '').trim() || null,
        })

      try {
        const user = tryCreate(username)
        return { userId: user.id, workspaceId, tenantId, created }
      } catch {
        username = `${deriveZitadelLocalUsername(emailNorm || '', sub).slice(0, 48)}_${randomBytes(3).toString('hex')}`
        const user = tryCreate(username)
        return { userId: user.id, workspaceId, tenantId, created }
      }
    })()

    return { ok: true, ...out }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg }
  }
}
