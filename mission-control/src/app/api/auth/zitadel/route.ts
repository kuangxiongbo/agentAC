/**
 * OIDC 授权入口（对齐奕升 `1sheng-console/server/http/routes/oidcAuth.ts` 中 `GET /api/auth/zitadel`：
 * PKCE、短期 flow Cookie、302 至 IdP authorize）。
 */
import { NextRequest, NextResponse } from 'next/server'
import { getMcSessionCookieOptions, isRequestSecure } from '@/lib/session-cookie'
import { oidcFlowLimiter } from '@/lib/rate-limit'
import {
  buildAuthorizationUrl,
  generatePkcePair,
  oidcIsConfigured,
  randomUrlToken,
} from '@/lib/oidc-zitadel'
import { signOidcFlowCookie } from '@/lib/oidc-flow-cookie'
import { resolveRequestOrigin } from '@/lib/request-origin'

export const dynamic = 'force-dynamic'

const OIDC_FLOW_COOKIE = 'mc_oidc_flow'

function sanitizeReturnTo(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return '/'
  if (!value.startsWith('/')) return '/'
  if (value.startsWith('//')) return '/'
  const pathOnly = value.split('?')[0] || ''
  // 避免 OIDC 完成后仍 302 回 /login（无 next 时用户会误以为未登录）
  if (pathOnly === '/login' || pathOnly === '/login/') return '/'
  return value.slice(0, 512)
}

/**
 * GET /api/auth/zitadel — 发起 Zitadel OIDC 授权码 + PKCE（见文件头对照说明）。
 */
export async function GET(request: NextRequest) {
  const rateCheck = oidcFlowLimiter(request)
  if (rateCheck) return rateCheck

  const returnTo = sanitizeReturnTo(request.nextUrl.searchParams.get('return_to'))

  if (!oidcIsConfigured()) {
    const u = new URL('/login', resolveRequestOrigin(request))
    u.searchParams.set('login_error', 'oidc_not_configured')
    if (returnTo !== '/') u.searchParams.set('next', returnTo)
    return NextResponse.redirect(u, 302)
  }

  try {
    const { verifier, challenge } = generatePkcePair()
    const state = randomUrlToken(18)
    const nonce = randomUrlToken(18)
    const loginHint = String(request.nextUrl.searchParams.get('login_hint') || '').trim()

    const flowSigned = signOidcFlowCookie({
      state,
      nonce,
      codeVerifier: verifier,
      returnTo,
    })

    const authUrl = await buildAuthorizationUrl({
      state,
      nonce,
      codeChallenge: challenge,
      loginHint: loginHint || null,
    })

    const isSecureRequest = isRequestSecure(request)
    const res = NextResponse.redirect(authUrl, 302)
    res.headers.set('Cache-Control', 'no-store')
    res.cookies.set(OIDC_FLOW_COOKIE, flowSigned, {
      ...getMcSessionCookieOptions({ maxAgeSeconds: 600, isSecureRequest, sameSite: 'lax' }),
    })
    return res
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[api/auth/zitadel]', msg, e)
    const u = new URL('/login', resolveRequestOrigin(request))
    u.searchParams.set('login_error', 'oidc_start_failed')
    if (returnTo !== '/') u.searchParams.set('next', returnTo)
    return NextResponse.redirect(u, 302)
  }
}
