import { afterEach, describe, expect, it } from 'vitest'
import { getMcSessionCookieOptions } from '../session-cookie'

describe('getMcSessionCookieOptions', () => {
  const env = process.env as Record<string, string | undefined>
  const originalNodeEnv = env.NODE_ENV
  const originalCookieSecure = env.MC_COOKIE_SECURE
  const originalSameSite = env.MC_COOKIE_SAMESITE

  afterEach(() => {
    if (originalNodeEnv === undefined) delete env.NODE_ENV
    else env.NODE_ENV = originalNodeEnv

    if (originalCookieSecure === undefined) delete env.MC_COOKIE_SECURE
    else env.MC_COOKIE_SECURE = originalCookieSecure

    if (originalSameSite === undefined) delete env.MC_COOKIE_SAMESITE
    else env.MC_COOKIE_SAMESITE = originalSameSite
  })

  it('does not force secure cookies on plain HTTP in production when MC_COOKIE_SECURE is unset', () => {
    env.NODE_ENV = 'production'
    delete env.MC_COOKIE_SECURE

    const options = getMcSessionCookieOptions({ maxAgeSeconds: 60, isSecureRequest: false })
    expect(options.secure).toBe(false)
  })

  it('sets secure cookies for HTTPS requests when MC_COOKIE_SECURE is unset', () => {
    env.NODE_ENV = 'production'
    delete env.MC_COOKIE_SECURE

    const options = getMcSessionCookieOptions({ maxAgeSeconds: 60, isSecureRequest: true })
    expect(options.secure).toBe(true)
  })

  it('defaults secure true on HTTPS when MC_COOKIE_SECURE unset (incl. dev TLS)', () => {
    env.NODE_ENV = 'development'
    delete env.MC_COOKIE_SECURE
    const options = getMcSessionCookieOptions({ maxAgeSeconds: 60, isSecureRequest: true })
    expect(options.secure).toBe(true)
  })

  it('ignores MC_COOKIE_SECURE on plain HTTP so the browser will accept session cookies (OIDC callback)', () => {
    env.NODE_ENV = 'production'
    env.MC_COOKIE_SECURE = '1'

    const options = getMcSessionCookieOptions({ maxAgeSeconds: 60, isSecureRequest: false })
    expect(options.secure).toBe(false)
  })

  it('honors MC_COOKIE_SECURE on HTTPS', () => {
    env.NODE_ENV = 'development'
    env.MC_COOKIE_SECURE = '0'

    const options = getMcSessionCookieOptions({ maxAgeSeconds: 60, isSecureRequest: true })
    expect(options.secure).toBe(false)
  })

  it('defaults session SameSite to lax when MC_COOKIE_SAMESITE unset (OIDC-friendly)', () => {
    delete env.MC_COOKIE_SAMESITE
    const options = getMcSessionCookieOptions({ maxAgeSeconds: 60, isSecureRequest: false })
    expect(options.sameSite).toBe('lax')
  })

  it('honors MC_COOKIE_SAMESITE=strict when set', () => {
    env.MC_COOKIE_SAMESITE = 'strict'
    const options = getMcSessionCookieOptions({ maxAgeSeconds: 60, isSecureRequest: false })
    expect(options.sameSite).toBe('strict')
  })

  it('allows sameSite lax for OIDC flow cookies', () => {
    const options = getMcSessionCookieOptions({ maxAgeSeconds: 600, isSecureRequest: true, sameSite: 'lax' })
    expect(options.sameSite).toBe('lax')
  })
})
