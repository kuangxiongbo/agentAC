import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/rate-limit', () => ({
  oidcFlowLimiter: () => null,
}))

vi.mock('@/lib/oidc-zitadel', () => ({
  oidcIsConfigured: () => true,
  generatePkcePair: () => ({
    verifier: `${'v'.repeat(43)}`,
    challenge: `${'c'.repeat(43)}`,
  }),
  randomUrlToken: (n: number) => `${'s'.repeat(Math.max(1, n))}`.slice(0, n),
  buildAuthorizationUrl: vi.fn(async () => 'https://idp.example/oauth/authorize'),
}))

describe('GET /api/auth/zitadel', () => {
  const prevAuth = process.env.AUTH_SECRET

  beforeEach(() => {
    process.env.AUTH_SECRET = 'unit-test-auth-secret-32chars!!'
  })

  afterEach(() => {
    process.env.AUTH_SECRET = prevAuth
    vi.resetModules()
  })

  it('sets mc_oidc_flow with SameSite=Lax for cross-site return from IdP', async () => {
    const { GET } = await import('@/app/api/auth/zitadel/route')
    const req = new NextRequest('http://127.0.0.1:5000/api/auth/zitadel?return_to=/tasks')
    const res = await GET(req)
    expect(res.status).toBe(302)
    const c = res.cookies.get('mc_oidc_flow')
    expect(c).toBeDefined()
    expect(c?.value?.length).toBeGreaterThan(10)
    expect((c as { sameSite?: string }).sameSite ?? (c as { options?: { sameSite?: string } }).options?.sameSite).toBe(
      'lax'
    )
  })
})
