import type { ResponseCookie } from 'next/dist/compiled/@edge-runtime/cookies'

export const MC_SESSION_COOKIE_NAME = '__Host-mc-session'
export const LEGACY_MC_SESSION_COOKIE_NAME = 'mc-session'
const MC_SESSION_COOKIE_NAMES = [MC_SESSION_COOKIE_NAME, LEGACY_MC_SESSION_COOKIE_NAME] as const

export function getMcSessionCookieName(isSecureRequest: boolean): string {
  return isSecureRequest ? MC_SESSION_COOKIE_NAME : LEGACY_MC_SESSION_COOKIE_NAME
}

export function isRequestSecure(request: Request): boolean {
  return request.headers.get('x-forwarded-proto') === 'https'
    || new URL(request.url).protocol === 'https:'
}

export function parseMcSessionCookieHeader(cookieHeader: string): string | null {
  if (!cookieHeader) return null
  for (const cookieName of MC_SESSION_COOKIE_NAMES) {
    const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${cookieName}=([^;]*)`))
    if (match) {
      return decodeURIComponent(match[1])
    }
  }
  return null
}

function envFlag(name: string): boolean | undefined {
  const raw = process.env[name]
  if (raw === undefined) return undefined
  const v = String(raw).trim().toLowerCase()
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false
  return undefined
}

function resolveDefaultSameSite(): 'strict' | 'lax' | 'none' {
  const v = String(process.env.MC_COOKIE_SAMESITE || '').trim().toLowerCase()
  if (v === 'strict' || v === 'lax' || v === 'none') return v
  // Zitadel 等 OIDC：从 IdP 顶级跳转回本域 `/api/auth/callback` 时写会话 Cookie，Strict 会被部分浏览器丢弃，随后 `/api/auth/me` 401 又回登录页。
  return 'lax'
}

export function getMcSessionCookieOptions(input: {
  maxAgeSeconds: number
  isSecureRequest?: boolean
  /**
   * OIDC 短期 Cookie `mc_oidc_flow` 在发起路由中显式传 `sameSite: 'lax'`。
   * 会话类 Cookie 默认 SameSite 见 `resolveDefaultSameSite()`（未配置 `MC_COOKIE_SAMESITE` 时为 **lax**，以支持 IdP 顶级跳回写会话）。
   */
  sameSite?: 'strict' | 'lax' | 'none'
}): Partial<ResponseCookie> {
  const secureEnv = envFlag('MC_COOKIE_SECURE')
  const isSecureConnection = Boolean(input.isSecureRequest)

  // 浏览器会丢弃「非 HTTPS 连接上的 Secure Cookie」。HTTP 开发环境若误设 MC_COOKIE_SECURE=1，
  // OIDC 回调里 Set-Cookie 会被静默忽略，用户会回到 /login 且看似「SSO 已成功」。
  let secure: boolean
  if (!isSecureConnection) {
    secure = false
  } else {
    secure = secureEnv !== undefined ? secureEnv : true
  }

  return {
    httpOnly: true,
    secure,
    sameSite: input.sameSite ?? resolveDefaultSameSite(),
    maxAge: input.maxAgeSeconds,
    path: '/',
  }
}
