import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { signOidcFlowCookie, verifyOidcFlowCookie } from '@/lib/oidc-flow-cookie'

describe('oidc-flow-cookie', () => {
  const prev = process.env.AUTH_SECRET

  beforeEach(() => {
    process.env.AUTH_SECRET = 'unit-test-auth-secret-32chars!!'
  })

  afterEach(() => {
    process.env.AUTH_SECRET = prev
  })

  it('round-trips flow payload', () => {
    const raw = signOidcFlowCookie({
      state: 'st',
      nonce: 'nc',
      codeVerifier: 'ver',
      returnTo: '/dashboard',
    })
    const parsed = verifyOidcFlowCookie(raw)
    expect(parsed).toEqual({
      state: 'st',
      nonce: 'nc',
      codeVerifier: 'ver',
      returnTo: '/dashboard',
    })
  })

  it('rejects tampered token', () => {
    const raw = signOidcFlowCookie({
      state: 'a',
      nonce: 'b',
      codeVerifier: 'c',
      returnTo: '/',
    })
    const [b64, sig] = raw.split('.')
    const tampered = `${b64.slice(0, -1)}x.${sig}`
    expect(verifyOidcFlowCookie(tampered)).toBeNull()
  })
})
