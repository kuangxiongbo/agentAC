import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { getZitadelOidcConfig, oidcIsConfigured } from '@/lib/oidc-zitadel'
import { resolveZitadelRegisterUrl } from '@/lib/zitadel-register-url'
import { parseMcSessionCookieHeader } from '@/lib/session-cookie'
import { validateSession } from '@/lib/auth'
import { config } from '@/lib/config'

export const dynamic = 'force-dynamic'

export type UnifiedLoginMode = 'off' | 'sso_primary' | 'sso_only'

function resolveUnifiedLoginMode(): UnifiedLoginMode {
  if (!oidcIsConfigured()) return 'off'
  const v = String(process.env.MC_UNIFIED_LOGIN || '').trim().toLowerCase()
  if (v === 'sso_only' || v === 'only') return 'sso_only'
  return 'sso_primary'
}

/** 与 ZITADEL_REDIRECT_URI 同源，用于登录页检测「localhost / 127.0.0.1 混用」并跳转。 */
function resolveOidcEntryOrigin(): string | null {
  if (!oidcIsConfigured()) return null
  const raw = String(getZitadelOidcConfig().redirectUri || '').trim()
  if (!raw) return null
  try {
    return new URL(raw).origin
  } catch {
    return null
  }
}

/**
 * GET /api/auth/sso — Zitadel OIDC 是否就绪 + 统一登录展示模式（供登录页布局）。
 * - sso_primary：统一登录为主，本地账号默认折叠
 * - sso_only：仅 SSO（/login 将跳转 IdP；`?local=1` 显示本地表单）
 * - registerUrl：与 Zitadel 自助注册页相同的完整 URL（`ZITADEL_REGISTER_URL` / `NEXT_PUBLIC_SSO_REGISTER_URL`）；未配置时若存在 `ZITADEL_ISSUER` 则回退为 `{issuer}/ui/login/register`；皆无则 null
 * - oidcEntryOrigin：`ZITADEL_REDIRECT_URI` 的 origin；与当前浏览器 origin 不一致时应跳转，否则 OIDC 临时 Cookie 无法随回调带回
 * - hasMcSession：已存在有效会话 Cookie 且未关闭鉴权时，登录页可直接进 `return_to` / 首页，无需再走 IdP
 */
export async function GET(request: NextRequest) {
  const zitadel = oidcIsConfigured()
  const mode = resolveUnifiedLoginMode()
  const registerUrl = resolveZitadelRegisterUrl()
  const oidcEntryOrigin = resolveOidcEntryOrigin()

  let hasMcSession = false
  if (!config.authDisabled) {
    const token = parseMcSessionCookieHeader(request.headers.get('cookie') || '')
    hasMcSession = Boolean(token && validateSession(token))
  }

  return NextResponse.json(
    { zitadel, mode, registerUrl, oidcEntryOrigin, hasMcSession },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
