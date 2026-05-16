/**
 * 浏览器端 Zitadel OIDC 入口构造。
 *
 * 对照已成功联调的奕升控制台（同源 `/api/auth/zitadel`、PKCE、短期 flow Cookie）：
 * - `…/1sheng-console/src/admin/useAdminSession.ts` — `startHostedLogin`（`window.location.origin` + `return_to` + `login_hint`）
 * - `…/1sheng-console/server/http/routes/oidcAuth.ts` — `GET /api/auth/zitadel`、`GET /api/auth/callback`
 * - `…/1sheng-console/server/config/cookies.ts` — 短期 Cookie `sameSite: 'lax'`（与 MC `mc_oidc_flow` 的 Lax 策略一致）
 *
 * Mission Control 服务端路由：`/api/auth/zitadel`、`/api/auth/callback`（Next App Router）。
 */

/** 开放重定向防护：仅允许站内相对路径作为 OIDC `return_to`（可含 query，如 `/tasks?tab=1`）。 */
export function sanitizeOidcReturnPath(raw: string | null | undefined): string {
  const v = typeof raw === 'string' ? raw.trim() : ''
  if (!v.startsWith('/') || v.startsWith('//')) return '/'
  return v.slice(0, 512)
}

/**
 * 解析登录成功后的站内 `return_to`（对齐 1sheng-console `startHostedLogin` 里对 `return_to` 的语义）。
 * 优先 URL 查询参数 `next`、`return_to`；若在 `/login` 且无上述参数则回 `/`，避免 OIDC 完成后回到登录页。
 */
export function resolveOidcPostLoginReturnTo(): string {
  if (typeof window === 'undefined') return '/'
  try {
    const sp = new URLSearchParams(window.location.search)
    const next = sanitizeOidcReturnPath(sp.get('next'))
    if (next !== '/') return next
    const explicit = sanitizeOidcReturnPath(sp.get('return_to'))
    if (explicit !== '/') return explicit
    const pathname = window.location.pathname || '/'
    if (pathname === '/login' || pathname.startsWith('/login/')) return '/'
    return sanitizeOidcReturnPath(`${window.location.pathname}${window.location.search}`)
  } catch {
    return '/'
  }
}

/** 生成「开始 Zitadel 登录」的绝对 URL；默认 **与奕升 `useAdminSession.startHostedLogin` 一致**——使用当前页 `origin`，不跨主机。
 * 仅在有特殊反向代理需求时传入 `baseOrigin`（一般勿用，以免与 `ZITADEL_REDIRECT_URI` 不同源导致 flow Cookie 丢失）。 */
export function buildZitadelStartLoginUrl(options?: { returnTo?: string; loginHint?: string; baseOrigin?: string | null }): string {
  const origin = String(options?.baseOrigin || '').trim()
    || (typeof window !== 'undefined' ? window.location.origin : 'http://localhost')
  const url = new URL('/api/auth/zitadel', origin)
  const returnTo = sanitizeOidcReturnPath(options?.returnTo ?? null)
  url.searchParams.set('return_to', returnTo || '/')
  const hint = String(options?.loginHint || '').trim()
  if (hint) url.searchParams.set('login_hint', hint)
  return url.toString()
}

/**
 * POST /api/auth/logout 后若返回 IdP `redirectUrl`，则跳转（对齐 1sheng-console `useAdminSession.logout`）。
 */
export async function logoutThenFollowSsoRedirect(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const res = await fetchImpl('/api/auth/logout', { method: 'POST', credentials: 'include', cache: 'no-store' })
  const data = (await res.json().catch(() => ({}))) as { redirectUrl?: string }
  if (typeof data.redirectUrl === 'string' && data.redirectUrl.trim()) {
    window.location.href = data.redirectUrl.trim()
    return true
  }
  return false
}
