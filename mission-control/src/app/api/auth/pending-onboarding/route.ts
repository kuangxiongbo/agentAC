import { NextRequest, NextResponse } from 'next/server'
import { getMcSessionCookieOptions, isRequestSecure } from '@/lib/session-cookie'
import {
  MC_PENDING_ONBOARDING_COOKIE,
  readOnboardingProofFromRequest,
  verifyZitadelOnboardingProof,
} from '@/lib/zitadel-onboarding-proof'

export const dynamic = 'force-dynamic'

function clearPendingCookie(res: NextResponse, request: NextRequest) {
  res.cookies.set(MC_PENDING_ONBOARDING_COOKIE, '', {
    ...getMcSessionCookieOptions({ maxAgeSeconds: 0, isSecureRequest: isRequestSecure(request), sameSite: 'lax' }),
  })
}

export async function GET(request: NextRequest) {
  const token = request.cookies.get(MC_PENDING_ONBOARDING_COOKIE)?.value || ''
  if (!token) {
    return NextResponse.json({ pending: false }, { headers: { 'Cache-Control': 'no-store' } })
  }
  const proof = verifyZitadelOnboardingProof(token)
  if (!proof) {
    const res = NextResponse.json({ pending: false }, { headers: { 'Cache-Control': 'no-store' } })
    clearPendingCookie(res, request)
    return res
  }
  return NextResponse.json(
    {
      pending: true,
      proofToken: token,
      email: proof.email,
      displayName: proof.displayName,
      returnTo: proof.returnTo,
      zitadelSub: proof.zitadelSub,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}

export async function DELETE(request: NextRequest) {
  const res = NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
  clearPendingCookie(res, request)
  return res
}

export { readOnboardingProofFromRequest }
