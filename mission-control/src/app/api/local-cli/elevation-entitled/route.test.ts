import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/edge-bootstrap', () => ({
  validateScopedDistributionEnrollToken: vi.fn((token: string) => {
    if (token !== 'mcet_valid') return null
    return {
      v: 1,
      typ: 'edge-enroll',
      uid: 42,
      tid: 7,
      wid: 3,
      iat: 1,
      exp: 9999999999,
    }
  }),
}))

describe('local CLI elevation entitlement route helpers', () => {
  it('resolves user and tenant from a scoped edge enroll token', async () => {
    const { resolveScopedEdgePrincipal } = await import('./route')
    const request = new Request('http://localhost/api/local-cli/elevation-entitled', {
      headers: { 'x-edge-enroll-token': 'mcet_valid' },
    })

    expect(resolveScopedEdgePrincipal(request)).toEqual({
      id: 42,
      tenant_id: 7,
      portal_tenant_role: null,
    })
  })

  it('ignores missing or invalid scoped edge enroll tokens', async () => {
    const { resolveScopedEdgePrincipal } = await import('./route')

    expect(resolveScopedEdgePrincipal(new Request('http://localhost'))).toBeNull()
    expect(
      resolveScopedEdgePrincipal(
        new Request('http://localhost', {
          headers: { 'x-edge-enroll-token': 'wrong' },
        }),
      ),
    ).toBeNull()
  })
})
