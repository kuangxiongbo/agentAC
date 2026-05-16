/**
 * 与奕升 `1sheng-console/server/services/usercenterTenantGateway.ts` 对齐：
 * 服务端调用用户中心 `POST /api/internal/tenant-context` 判断 Zitadel 主体是否已绑定租户。
 * 未配置 `USER_CENTER_API_URL` 时跳过（Mission Control 仅走本地 users 表，行为与旧版一致）。
 * 配置示例（奕升）：`USER_CENTER_API_URL=https://user.1sheng.work`（或带路径的 API 基址），服务端请求 `POST {基址}/api/internal/tenant-context`。
 */

export type UsercenterTenantContext = {
  hasTenant: boolean
  reason?: string
  user?: {
    id: number
    email: string
    displayName: string
  }
  tenant?: {
    id: string
    name: string
    slug: string
    role: string
  }
  memberships?: Array<{
    id: string
    name: string
    slug: string
    role: string
  }>
}

function internalHeaders(): Record<string, string> {
  const secret = String(process.env.USER_CENTER_INTERNAL_SECRET || '').trim()
  return {
    'Content-Type': 'application/json',
    ...(secret ? { 'X-Internal-Secret': secret } : {}),
  }
}

async function parseJsonSafe<T>(resp: Response): Promise<T | null> {
  try {
    return (await resp.json()) as T
  } catch {
    return null
  }
}

function requireUsercenterApiBase(): string | null {
  const base = String(process.env.USER_CENTER_API_URL || process.env.USERCENTER_ORIGIN || '')
    .trim()
    .replace(/\/+$/, '')
  return base || null
}

/** 是否已配置用户中心 API 基址（第二步租户/角色校验是否可能执行）。 */
export function isUsercenterApiConfigured(): boolean {
  return requireUsercenterApiBase() !== null
}

/** 浏览器应跳转的用户中心根地址；未显式配置时回退为 `USER_CENTER_API_URL` 的 origin。 */
export function resolveUserCenterPortalBase(): string | null {
  const explicit = String(process.env.USER_CENTER_PORTAL_URL || '').trim().replace(/\/+$/, '')
  if (explicit) {
    try {
      return new URL(explicit).toString().replace(/\/+$/, '')
    } catch {
      return null
    }
  }
  const api = requireUsercenterApiBase()
  if (!api) return null
  try {
    const u = new URL(api)
    return u.origin
  } catch {
    return null
  }
}

export type FetchUsercenterTenantContextResult =
  | { configured: false }
  | { configured: true; ok: true; data: UsercenterTenantContext }
  | { configured: true; ok: false; error: string }

/**
 * 若未配置用户中心 API，返回 `{ configured: false }`，调用方应跳过租户门闸。
 */
export async function fetchUsercenterTenantContextIfConfigured(input: {
  subject: string
  email: string | null
  displayName: string
}): Promise<FetchUsercenterTenantContextResult> {
  const base = requireUsercenterApiBase()
  if (!base) return { configured: false }

  const subject = String(input.subject || '').trim()
  if (!subject) {
    return { configured: true, ok: true, data: { hasTenant: false, reason: 'missing_subject' } }
  }

  try {
    const resp = await fetch(`${base}/api/internal/tenant-context`, {
      method: 'POST',
      headers: internalHeaders(),
      body: JSON.stringify({
        subject,
        email: input.email || undefined,
        displayName: input.displayName || undefined,
      }),
      signal: AbortSignal.timeout(8000),
    })
    const data = await parseJsonSafe<UsercenterTenantContext & { error?: string }>(resp)
    if (!resp.ok) {
      return {
        configured: true,
        ok: false,
        error: data?.error || `tenant-context HTTP ${resp.status}`,
      }
    }
    return {
      configured: true,
      ok: true,
      data: data || { hasTenant: false, reason: 'empty' },
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { configured: true, ok: false, error: msg }
  }
}

/** 拼接跳转用户中心「完善租户 / 入驻」的 URL（与 1sheng `?onboarding=1` 语义对齐，并带上回到 MC 的提示参数）。 */
export function buildUserCenterOnboardingRedirectUrl(input: {
  portalBase: string
  subject: string
  email: string
  displayName: string
  mcOrigin: string
  returnTo: string
  reason?: string
}): string {
  const pathRaw = String(process.env.USER_CENTER_ONBOARDING_PATH || '/login').trim() || '/login'
  const path = pathRaw.startsWith('/') ? pathRaw : `/${pathRaw}`
  const base = input.portalBase.replace(/\/+$/, '')
  const u = new URL(path, `${base}/`)

  u.searchParams.set('from', 'mission-control')
  u.searchParams.set('onboarding', '1')
  u.searchParams.set('sub', input.subject.slice(0, 200))
  if (input.email) u.searchParams.set('login_hint', input.email.slice(0, 254))
  if (input.displayName) u.searchParams.set('display_name', input.displayName.slice(0, 200))
  u.searchParams.set('mc_origin', input.mcOrigin.slice(0, 256))
  const rt = input.returnTo.startsWith('/') && !input.returnTo.startsWith('//') ? input.returnTo.slice(0, 512) : '/'
  u.searchParams.set('mc_return_to', rt)
  if (input.reason) u.searchParams.set('uc_reason', input.reason.slice(0, 120))
  return u.toString()
}

export type UsercenterTenantSearchResult =
  | {
      exactMatch: true
      tenant: { id: number; name: string; slug: string }
    }
  | {
      exactMatch: false
      suggestion: { id: number; nameMasked: string; slug: string } | null
    }

export type UsercenterOnboardingStatus = {
  hasTenant: boolean
  tenant?: { id: string; name: string; slug: string; role: string }
  applications: Array<{
    id: number
    status: string
    createdAt: string
    tenantId: number
    tenantName: string
  }>
}

function requireUsercenterApiOrThrow(): string {
  const base = requireUsercenterApiBase()
  if (!base) throw new Error('USER_CENTER_API_URL 未配置')
  return base
}

export async function searchUsercenterTenant(input: {
  subject: string
  email?: string | null
  displayName?: string | null
  q: string
}): Promise<UsercenterTenantSearchResult> {
  const base = requireUsercenterApiOrThrow()
  const resp = await fetch(`${base}/api/internal/onboarding/search-tenant`, {
    method: 'POST',
    headers: internalHeaders(),
    body: JSON.stringify({
      subject: input.subject,
      email: input.email || undefined,
      displayName: input.displayName || undefined,
      q: input.q,
    }),
    signal: AbortSignal.timeout(8000),
  })
  const data = await parseJsonSafe<UsercenterTenantSearchResult & { error?: string }>(resp)
  if (!resp.ok) throw new Error(data?.error || `search-tenant HTTP ${resp.status}`)
  return (data || { exactMatch: false, suggestion: null }) as UsercenterTenantSearchResult
}

export async function createUsercenterTenant(input: {
  subject: string
  email?: string | null
  displayName?: string | null
  name: string
  slug: string
}): Promise<{ ok: true; tenantId: number; slug: string }> {
  const base = requireUsercenterApiOrThrow()
  const resp = await fetch(`${base}/api/internal/onboarding/create-tenant`, {
    method: 'POST',
    headers: internalHeaders(),
    body: JSON.stringify({
      subject: input.subject,
      email: input.email || undefined,
      displayName: input.displayName || undefined,
      name: input.name,
      slug: input.slug,
    }),
    signal: AbortSignal.timeout(10000),
  })
  const data = await parseJsonSafe<{ ok?: boolean; tenantId?: number; slug?: string; error?: string }>(resp)
  if (!resp.ok || data?.ok !== true || !data?.tenantId) {
    throw new Error(data?.error || `create-tenant HTTP ${resp.status}`)
  }
  return { ok: true, tenantId: Number(data.tenantId), slug: String(data.slug || '').trim() }
}

export async function applyUsercenterTenant(input: {
  subject: string
  email?: string | null
  displayName?: string | null
  tenantId: number
}): Promise<{ ok: true }> {
  const base = requireUsercenterApiOrThrow()
  const resp = await fetch(`${base}/api/internal/onboarding/apply-tenant`, {
    method: 'POST',
    headers: internalHeaders(),
    body: JSON.stringify({
      subject: input.subject,
      email: input.email || undefined,
      displayName: input.displayName || undefined,
      tenantId: input.tenantId,
    }),
    signal: AbortSignal.timeout(8000),
  })
  const data = await parseJsonSafe<{ ok?: boolean; error?: string }>(resp)
  if (!resp.ok || data?.ok !== true) {
    throw new Error(data?.error || `apply-tenant HTTP ${resp.status}`)
  }
  return { ok: true }
}

export async function fetchUsercenterOnboardingStatus(subject: string): Promise<UsercenterOnboardingStatus> {
  const base = requireUsercenterApiOrThrow()
  const resp = await fetch(`${base}/api/internal/onboarding/status/${encodeURIComponent(subject)}`, {
    method: 'GET',
    headers: internalHeaders(),
    signal: AbortSignal.timeout(8000),
  })
  const data = await parseJsonSafe<UsercenterOnboardingStatus & { error?: string }>(resp)
  if (!resp.ok) throw new Error(data?.error || `onboarding-status HTTP ${resp.status}`)
  return (data || { hasTenant: false, applications: [] }) as UsercenterOnboardingStatus
}

/** `local`：MC 内入驻页；`portal`：302 到用户中心门户（旧行为）。默认 `local`（对齐 1sheng-console OnboardingGate）。 */
export function resolveUsercenterOnboardingMode(): 'local' | 'portal' {
  const raw = String(process.env.MC_USERCENTER_ONBOARDING_MODE || 'local').trim().toLowerCase()
  return raw === 'portal' ? 'portal' : 'local'
}
