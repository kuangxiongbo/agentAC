import type { CurrentUser } from '@/store'

const COMMON_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'qq.com',
  '163.com',
  '126.com',
  'icloud.com',
  'yahoo.com',
])

export function isIdentityProviderUser(user: Pick<CurrentUser, 'provider'> | null | undefined): boolean {
  const provider = user?.provider || 'local'
  return provider === 'zitadel' || provider === 'google'
}

/** 平台级多租户切换：仅本地管理员，且未显式关闭。IdP 用户永远只看自己的单位。 */
export function canManageAllTenants(user: Pick<CurrentUser, 'provider' | 'role'> | null | undefined): boolean {
  if (!user || user.role !== 'admin') return false
  if (isIdentityProviderUser(user)) return false
  const flag = String(process.env.MC_PLATFORM_MULTI_TENANT_UI || '').trim().toLowerCase()
  return flag === '1' || flag === 'true' || flag === 'yes'
}

export function resolveAutoOrganizationName(input: {
  displayName: string
  email: string
  preferredName?: string
}): string {
  const fromEnv = String(process.env.MC_AUTO_TENANT_DISPLAY_NAME || '').trim()
  if (fromEnv) return fromEnv.slice(0, 256)

  const preferred = String(input.preferredName || '').trim()
  if (preferred) return preferred.slice(0, 256)

  const email = String(input.email || '').trim().toLowerCase()
  if (email.includes('@')) {
    const domain = email.split('@')[1] || ''
    if (domain && !COMMON_EMAIL_DOMAINS.has(domain)) {
      const label = domain.split('.')[0] || domain
      if (label.length >= 2) return label.slice(0, 256)
    }
  }

  const displayName = String(input.displayName || '').trim()
  if (displayName.length >= 2) return displayName.slice(0, 256)

  return '默认组织'
}

export function slugFromOrganizationName(name: string, fallback = 'org'): string {
  const base = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return base || fallback
}

export function tenantFromOrganization(org: {
  tenant_id: number
  display_name: string
  slug: string
}): import('@/store').Tenant {
  return {
    id: org.tenant_id,
    slug: org.slug,
    display_name: org.display_name,
    status: 'active',
    linux_user: '',
  }
}
