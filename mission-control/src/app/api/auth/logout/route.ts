import { NextResponse } from 'next/server'
import { destroySession, getUserFromRequest } from '@/lib/auth'
import { logAuditEvent } from '@/lib/db'
import { buildEndSessionUrl } from '@/lib/oidc-zitadel'
import { getMcSessionCookieName, getMcSessionCookieOptions, isRequestSecure, parseMcSessionCookieHeader } from '@/lib/session-cookie'

const OIDC_ID_TOKEN_COOKIE = 'mc_oidc_id_token'

export async function POST(request: Request) {
  const user = getUserFromRequest(request)
  const cookieHeader = request.headers.get('cookie') || ''
  const token = parseMcSessionCookieHeader(cookieHeader)

  if (token) {
    destroySession(token)
  }

  if (user) {
    const ipAddress = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown'
    logAuditEvent({ action: 'logout', actor: user.username, actor_id: user.id, ip_address: ipAddress })
  }

  const isSecureRequest = isRequestSecure(request)

  let redirectUrl: string | null = null
  try {
    const idMatch = cookieHeader.match(new RegExp(`(?:^|;\\s*)${OIDC_ID_TOKEN_COOKIE}=([^;]*)`))
    const idToken = idMatch ? decodeURIComponent(idMatch[1]) : ''
    if (user?.provider === 'zitadel' && idToken) {
      redirectUrl = await buildEndSessionUrl(idToken)
    }
  } catch {
    redirectUrl = null
  }

  const response = NextResponse.json({ ok: true, redirectUrl: redirectUrl || undefined })
  const cookieName = getMcSessionCookieName(isSecureRequest)
  response.cookies.set(cookieName, '', {
    ...getMcSessionCookieOptions({ maxAgeSeconds: 0, isSecureRequest }),
  })
  response.cookies.set(OIDC_ID_TOKEN_COOKIE, '', {
    ...getMcSessionCookieOptions({ maxAgeSeconds: 0, isSecureRequest }),
  })

  return response
}
