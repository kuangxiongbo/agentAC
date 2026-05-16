import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

const oidcIsConfigured = vi.fn()

vi.mock('@/lib/oidc-zitadel', () => ({
  oidcIsConfigured: () => oidcIsConfigured(),
  getZitadelOidcConfig: () => ({
    issuer: String(process.env.ZITADEL_ISSUER || ''),
    clientId: String(process.env.ZITADEL_CLIENT_ID || ''),
    clientSecret: String(process.env.ZITADEL_CLIENT_SECRET || ''),
    redirectUri: String(process.env.ZITADEL_REDIRECT_URI || ''),
    postLogoutRedirectUri: String(process.env.ZITADEL_POST_LOGOUT_REDIRECT_URI || ''),
  }),
}))

describe('GET /api/auth/sso', () => {
  const env = process.env as Record<string, string | undefined>
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    saved.ZITADEL_ISSUER = env.ZITADEL_ISSUER
    saved.ZITADEL_REGISTER_URL = env.ZITADEL_REGISTER_URL
    saved.NEXT_PUBLIC_SSO_REGISTER_URL = env.NEXT_PUBLIC_SSO_REGISTER_URL
    saved.ZITADEL_REDIRECT_URI = env.ZITADEL_REDIRECT_URI
    oidcIsConfigured.mockReturnValue(true)
  })

  afterEach(() => {
    for (const k of ['ZITADEL_ISSUER', 'ZITADEL_REGISTER_URL', 'NEXT_PUBLIC_SSO_REGISTER_URL', 'ZITADEL_REDIRECT_URI'] as const) {
      if (saved[k] !== undefined) env[k] = saved[k]
      else delete env[k]
    }
    oidcIsConfigured.mockReset()
    vi.resetModules()
  })

  it('returns registerUrl derived from ZITADEL_ISSUER when explicit URL unset', async () => {
    env.ZITADEL_ISSUER = 'https://sso.example.com'
    delete env.ZITADEL_REGISTER_URL
    delete env.NEXT_PUBLIC_SSO_REGISTER_URL
    const { GET } = await import('./sso/route')
    const res = await GET(new NextRequest('http://127.0.0.1/api/auth/sso'))
    const body = await res.json()
    expect(body.zitadel).toBe(true)
    expect(body.registerUrl).toBe('https://sso.example.com/ui/login/register')
    expect(body.hasMcSession).toBe(false)
  })

  it('returns oidcEntryOrigin parsed from ZITADEL_REDIRECT_URI', async () => {
    env.ZITADEL_ISSUER = 'https://sso.example.com'
    env.ZITADEL_REDIRECT_URI = 'http://127.0.0.1:5000/api/auth/callback'
    delete env.ZITADEL_REGISTER_URL
    delete env.NEXT_PUBLIC_SSO_REGISTER_URL
    const { GET } = await import('./sso/route')
    const res = await GET(new NextRequest('http://127.0.0.1/api/auth/sso'))
    const body = await res.json()
    expect(body.oidcEntryOrigin).toBe('http://127.0.0.1:5000')
    expect(body.hasMcSession).toBe(false)
  })
})
