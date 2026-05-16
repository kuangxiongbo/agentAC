import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { signOidcFlowCookie } from '@/lib/oidc-flow-cookie'

vi.mock('@/lib/rate-limit', () => ({
  oidcFlowLimiter: () => null,
}))

const hoisted = vi.hoisted(() => ({
  exchangeCodeForTokens: vi.fn(),
  verifyIdToken: vi.fn(),
  fetchOidcUserInfo: vi.fn(),
  createSession: vi.fn(),
  prepare: vi.fn(),
}))

vi.mock('@/lib/oidc-zitadel', () => ({
  oidcIsConfigured: () => true,
  exchangeCodeForTokens: (...args: unknown[]) => hoisted.exchangeCodeForTokens(...args),
  verifyIdToken: (...args: unknown[]) => hoisted.verifyIdToken(...args),
  fetchOidcUserInfo: (...args: unknown[]) => hoisted.fetchOidcUserInfo(...args),
}))

vi.mock('@/lib/auth', () => ({
  createSession: (...args: unknown[]) => hoisted.createSession(...args),
  createUser: vi.fn(),
  updateUser: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  getDatabase: () => ({
    prepare: (sql: string) => hoisted.prepare(sql),
  }),
  logAuditEvent: vi.fn(),
}))

vi.mock('@/lib/usercenter-tenant-gateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/usercenter-tenant-gateway')>()
  return {
    ...actual,
    fetchUsercenterTenantContextIfConfigured: vi.fn().mockResolvedValue({ configured: false }),
    resolveUserCenterPortalBase: vi.fn(),
    buildUserCenterOnboardingRedirectUrl: vi.fn(),
  }
})

describe('GET /api/auth/callback (Zitadel OIDC)', () => {
  const prevAuth = process.env.AUTH_SECRET
  const prevRequireUc = process.env.MC_ZITADEL_REQUIRE_USERCENTER
  const prevUserCenter = process.env.USER_CENTER_API_URL

  beforeEach(() => {
    process.env.AUTH_SECRET = 'unit-test-auth-secret-32chars!!'
    delete process.env.MC_ZITADEL_REQUIRE_USERCENTER
    delete process.env.USER_CENTER_API_URL
    hoisted.exchangeCodeForTokens.mockResolvedValue({
      idToken: 'header.payload.sig',
      accessToken: 'access-token',
    })
    hoisted.verifyIdToken.mockImplementation(async (_token: string, nonce: string) => ({
      sub: 'zitadel-sub-99',
      email: 'approved@example.com',
      preferredUsername: 'approved',
      name: 'Approved User',
      nonce,
    }))
    hoisted.fetchOidcUserInfo.mockResolvedValue({
      sub: 'zitadel-sub-99',
      email: 'approved@example.com',
      preferredUsername: 'approved',
      name: 'Approved User',
    })
    hoisted.createSession.mockReturnValue({
      token: 'mc-session-test-token',
      expiresAt: Math.floor(Date.now() / 1000) + 604800,
    })
    hoisted.prepare.mockImplementation((sql: string) => {
      if (sql.includes('FROM users')) {
        return {
          get: () => ({
            id: 42,
            username: 'approved',
            display_name: 'Approved User',
            role: 'admin',
            provider: 'zitadel',
            email: 'approved@example.com',
            avatar_url: null,
            is_approved: 1,
            portal_tenant_role: null,
            workspace_id: 1,
            tenant_id: 1,
            created_at: 0,
            updated_at: 0,
            last_login_at: null,
          }),
        }
      }
      if (sql.includes('UPDATE users')) {
        return { run: vi.fn() }
      }
      throw new Error(`Unexpected SQL in callback test: ${sql.slice(0, 120)}`)
    })
  })

  afterEach(() => {
    process.env.AUTH_SECRET = prevAuth
    if (prevRequireUc === undefined) delete process.env.MC_ZITADEL_REQUIRE_USERCENTER
    else process.env.MC_ZITADEL_REQUIRE_USERCENTER = prevRequireUc
    if (prevUserCenter === undefined) delete process.env.USER_CENTER_API_URL
    else process.env.USER_CENTER_API_URL = prevUserCenter
    vi.clearAllMocks()
  })

  it('302 redirects to returnTo and sets session cookie when flow cookie + code + state are valid', async () => {
    const state = 'state-token-abcdefghij'
    const nonce = 'nonce-token-abcdefghij'
    const codeVerifier = `${'a'.repeat(43)}`
    const flowCookie = signOidcFlowCookie({
      state,
      nonce,
      codeVerifier,
      returnTo: '/overview',
    })

    const { GET } = await import('@/app/api/auth/callback/route')
    const url = new URL('http://127.0.0.1:5000/api/auth/callback')
    url.searchParams.set('code', 'authorization-code-from-idp')
    url.searchParams.set('state', state)

    const req = new NextRequest(url, {
      headers: { cookie: `mc_oidc_flow=${flowCookie}` },
    })

    const res = await GET(req)

    expect(res.status).toBe(302)
    const loc = res.headers.get('location') || ''
    expect(loc).toContain('/auth/enter')
    expect(loc).toContain('next=')
    expect(decodeURIComponent(loc)).toContain('/overview')
    expect(hoisted.exchangeCodeForTokens).toHaveBeenCalledWith({
      code: 'authorization-code-from-idp',
      codeVerifier,
    })

    const setCookie = res.headers.get('set-cookie') || ''
    expect(setCookie).toMatch(/mc-session/)
    expect(setCookie).toContain('mc-session-test-token')
  })

  it('302 to /login with oidc_invalid_state when flow cookie is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { GET } = await import('@/app/api/auth/callback/route')
    const url = new URL('http://127.0.0.1:5000/api/auth/callback')
    url.searchParams.set('code', 'x')
    url.searchParams.set('state', 'y')
    const res = await GET(new NextRequest(url))
    expect(res.status).toBe(302)
    expect(res.headers.get('location') || '').toContain('/login')
    expect(res.headers.get('location') || '').toContain('login_error=oidc_invalid_state')
    warn.mockRestore()
  })

  it('302 to /login with usercenter_required when MC_ZITADEL_REQUIRE_USERCENTER without USER_CENTER_API_URL', async () => {
    process.env.MC_ZITADEL_REQUIRE_USERCENTER = '1'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const state = 'state-token-abcdefghij'
    const nonce = 'nonce-token-abcdefghij'
    const codeVerifier = `${'a'.repeat(43)}`
    const flowCookie = signOidcFlowCookie({
      state,
      nonce,
      codeVerifier,
      returnTo: '/',
    })
    const { GET } = await import('@/app/api/auth/callback/route')
    const url = new URL('http://127.0.0.1:5000/api/auth/callback')
    url.searchParams.set('code', 'authorization-code-from-idp')
    url.searchParams.set('state', state)
    const res = await GET(
      new NextRequest(url, {
        headers: { cookie: `mc_oidc_flow=${flowCookie}` },
      })
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location') || '').toContain('login_error=usercenter_required')
    warn.mockRestore()
  })
})
