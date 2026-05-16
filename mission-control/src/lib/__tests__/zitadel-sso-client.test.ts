import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  buildZitadelStartLoginUrl,
  sanitizeOidcReturnPath,
  resolveOidcPostLoginReturnTo,
} from '@/lib/zitadel-sso-client'

function stubWindow(loc: { pathname: string; search: string }) {
  vi.stubGlobal('window', {
    location: {
      pathname: loc.pathname,
      search: loc.search,
    },
  })
}

describe('zitadel-sso-client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolveOidcPostLoginReturnTo prefers next', () => {
    stubWindow({ pathname: '/login', search: '?next=%2Ftasks' })
    expect(resolveOidcPostLoginReturnTo()).toBe('/tasks')
  })

  it('resolveOidcPostLoginReturnTo prefers return_to when next absent', () => {
    stubWindow({ pathname: '/login', search: '?return_to=%2Fsettings' })
    expect(resolveOidcPostLoginReturnTo()).toBe('/settings')
  })

  it('resolveOidcPostLoginReturnTo on /login without hints goes home', () => {
    stubWindow({ pathname: '/login', search: '' })
    expect(resolveOidcPostLoginReturnTo()).toBe('/')
  })

  it('resolveOidcPostLoginReturnTo uses pathname+search off login (1sheng startHostedLogin)', () => {
    stubWindow({ pathname: '/agents', search: '?q=1' })
    expect(resolveOidcPostLoginReturnTo()).toBe('/agents?q=1')
  })

  it('sanitizeOidcReturnPath rejects open redirects', () => {
    expect(sanitizeOidcReturnPath('//evil')).toBe('/')
    expect(sanitizeOidcReturnPath('/ok')).toBe('/ok')
  })

  it('buildZitadelStartLoginUrl encodes return_to and login_hint', () => {
    const href = buildZitadelStartLoginUrl({
      returnTo: '/agents',
      loginHint: 'a@b.com',
    })
    const u = new URL(href)
    expect(u.pathname).toBe('/api/auth/zitadel')
    expect(u.searchParams.get('return_to')).toBe('/agents')
    expect(u.searchParams.get('login_hint')).toBe('a@b.com')
  })

  it('buildZitadelStartLoginUrl rejects open redirect', () => {
    const href = buildZitadelStartLoginUrl({ returnTo: '//evil.com' })
    const u = new URL(href)
    expect(u.searchParams.get('return_to')).toBe('/')
  })

  it('buildZitadelStartLoginUrl can target the OIDC callback origin', () => {
    const href = buildZitadelStartLoginUrl({
      returnTo: '/',
      baseOrigin: 'http://127.0.0.1:5000',
    })
    expect(new URL(href).origin).toBe('http://127.0.0.1:5000')
  })
})
