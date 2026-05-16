import { createHmac, timingSafeEqual } from 'crypto'

export type OidcFlowPayload = {
  state: string
  nonce: string
  codeVerifier: string
  returnTo: string
  exp: number
}

function getAuthSecret(): string {
  const s = (process.env.AUTH_SECRET || '').trim()
  if (!s) throw new Error('AUTH_SECRET is required for OIDC login')
  return s
}

export function signOidcFlowCookie(payload: { state: string; nonce: string; codeVerifier: string; returnTo: string }): string {
  const exp = Math.floor(Date.now() / 1000) + 600
  const body: OidcFlowPayload = { ...payload, exp }
  const json = JSON.stringify(body)
  const b64 = Buffer.from(json, 'utf8').toString('base64url')
  const sig = createHmac('sha256', getAuthSecret()).update(b64).digest('base64url')
  return `${b64}.${sig}`
}

export function verifyOidcFlowCookie(token: string): Omit<OidcFlowPayload, 'exp'> | null {
  const parts = String(token || '').split('.')
  if (parts.length !== 2) return null
  const [b64, sig] = parts
  if (!b64 || !sig) return null
  const expected = createHmac('sha256', getAuthSecret()).update(b64).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  let parsed: OidcFlowPayload
  try {
    parsed = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as OidcFlowPayload
  } catch {
    return null
  }
  if (!parsed.state || !parsed.nonce || !parsed.codeVerifier) return null
  if (typeof parsed.exp !== 'number' || parsed.exp < Math.floor(Date.now() / 1000)) return null
  return {
    state: parsed.state,
    nonce: parsed.nonce,
    codeVerifier: parsed.codeVerifier,
    returnTo: typeof parsed.returnTo === 'string' ? parsed.returnTo : '/',
  }
}
