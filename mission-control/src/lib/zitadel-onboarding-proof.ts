import { createHmac, timingSafeEqual } from 'crypto'
import type { NextRequest } from 'next/server'

export const MC_PENDING_ONBOARDING_COOKIE = 'mc_pending_onboarding'

export type ZitadelOnboardingProof = {
  zitadelSub: string
  email: string
  displayName: string
  returnTo: string
}

type SignedPayload = ZitadelOnboardingProof & { exp: number }

function getAuthSecret(): string {
  const s = (process.env.AUTH_SECRET || '').trim()
  if (!s) throw new Error('AUTH_SECRET is required for tenant onboarding proof')
  return s
}

export function signZitadelOnboardingProof(payload: ZitadelOnboardingProof): string {
  const body: SignedPayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + 900,
  }
  const b64 = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url')
  const sig = createHmac('sha256', getAuthSecret()).update(b64).digest('base64url')
  return `${b64}.${sig}`
}

export function verifyZitadelOnboardingProof(token: string): ZitadelOnboardingProof | null {
  const parts = String(token || '').split('.')
  if (parts.length !== 2) return null
  const [b64, sig] = parts
  if (!b64 || !sig) return null
  const expected = createHmac('sha256', getAuthSecret()).update(b64).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  let parsed: SignedPayload
  try {
    parsed = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as SignedPayload
  } catch {
    return null
  }
  if (typeof parsed.exp !== 'number' || parsed.exp < Math.floor(Date.now() / 1000)) return null
  const zitadelSub = String(parsed.zitadelSub || '').trim()
  const email = String(parsed.email || '').trim()
  const displayName = String(parsed.displayName || email || zitadelSub).trim()
  const returnTo =
    typeof parsed.returnTo === 'string' && parsed.returnTo.startsWith('/') && !parsed.returnTo.startsWith('//')
      ? parsed.returnTo.slice(0, 512)
      : '/'
  if (!zitadelSub || !email) return null
  return { zitadelSub, email, displayName, returnTo }
}

export function readOnboardingProofFromRequest(request: NextRequest): ZitadelOnboardingProof | null {
  const token = request.cookies.get(MC_PENDING_ONBOARDING_COOKIE)?.value || ''
  return verifyZitadelOnboardingProof(token)
}
