import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  buildUserCenterOnboardingRedirectUrl,
  fetchUsercenterTenantContextIfConfigured,
  isUsercenterApiConfigured,
  resolveUserCenterPortalBase,
} from '@/lib/usercenter-tenant-gateway'

describe('usercenter-tenant-gateway', () => {
  const prev = {
    api: process.env.USER_CENTER_API_URL,
    portal: process.env.USER_CENTER_PORTAL_URL,
    path: process.env.USER_CENTER_ONBOARDING_PATH,
    secret: process.env.USER_CENTER_INTERNAL_SECRET,
  }

  beforeEach(() => {
    delete process.env.USER_CENTER_API_URL
    delete process.env.USER_CENTER_PORTAL_URL
    delete process.env.USER_CENTER_ONBOARDING_PATH
    delete process.env.USER_CENTER_INTERNAL_SECRET
  })

  afterEach(() => {
    process.env.USER_CENTER_API_URL = prev.api
    process.env.USER_CENTER_PORTAL_URL = prev.portal
    process.env.USER_CENTER_ONBOARDING_PATH = prev.path
    process.env.USER_CENTER_INTERNAL_SECRET = prev.secret
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('fetchUsercenterTenantContextIfConfigured returns configured:false when API URL unset', async () => {
    const r = await fetchUsercenterTenantContextIfConfigured({
      subject: 'sub-1',
      email: 'a@b.com',
      displayName: 'A',
    })
    expect(r).toEqual({ configured: false })
    expect(isUsercenterApiConfigured()).toBe(false)
  })

  it('isUsercenterApiConfigured true when USER_CENTER_API_URL set', () => {
    process.env.USER_CENTER_API_URL = 'https://uc.example'
    expect(isUsercenterApiConfigured()).toBe(true)
  })

  it('resolveUserCenterPortalBase prefers USER_CENTER_PORTAL_URL', () => {
    process.env.USER_CENTER_PORTAL_URL = 'https://portal.example/onboarding/'
    expect(resolveUserCenterPortalBase()).toBe('https://portal.example/onboarding')
  })

  it('resolveUserCenterPortalBase falls back to API origin', () => {
    process.env.USER_CENTER_API_URL = 'https://uc.example/api/v1/'
    expect(resolveUserCenterPortalBase()).toBe('https://uc.example')
  })

  it('buildUserCenterOnboardingRedirectUrl carries mc hints', () => {
    process.env.USER_CENTER_ONBOARDING_PATH = '/register'
    const url = buildUserCenterOnboardingRedirectUrl({
      portalBase: 'https://uc.example',
      subject: 'z-1',
      email: 'u@x.com',
      displayName: 'User',
      mcOrigin: 'http://127.0.0.1:5000',
      returnTo: '/tasks',
      reason: 'unlinked_account',
    })
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe('https://uc.example/register')
    expect(u.searchParams.get('from')).toBe('mission-control')
    expect(u.searchParams.get('onboarding')).toBe('1')
    expect(u.searchParams.get('sub')).toBe('z-1')
    expect(u.searchParams.get('mc_return_to')).toBe('/tasks')
    expect(u.searchParams.get('uc_reason')).toBe('unlinked_account')
  })

  it('fetchUsercenterTenantContextIfConfigured posts to tenant-context', async () => {
    process.env.USER_CENTER_API_URL = 'https://uc.example'
    process.env.USER_CENTER_INTERNAL_SECRET = 'secret-xyz'
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ hasTenant: true, tenant: { id: '1', name: 'T', slug: 't', role: 'owner' } }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const r = await fetchUsercenterTenantContextIfConfigured({
      subject: 'sub-9',
      email: 'e@e.com',
      displayName: 'E',
    })

    expect(r.configured).toBe(true)
    if (r.configured && r.ok) {
      expect(r.data.hasTenant).toBe(true)
    }
    expect(fetchMock).toHaveBeenCalledWith(
      'https://uc.example/api/internal/tenant-context',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Internal-Secret': 'secret-xyz',
        }),
      })
    )
  })
})
