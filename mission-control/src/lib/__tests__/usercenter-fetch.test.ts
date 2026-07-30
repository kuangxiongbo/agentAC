import { afterEach, describe, expect, it, vi } from 'vitest'
import { __test__, userCenterFetch } from '../usercenter-fetch'

afterEach(() => {
  delete process.env.MC_USERCENTER_TLS_INSECURE
  vi.restoreAllMocks()
})

describe('userCenterFetch', () => {
  it('keeps strict TLS validation by default', () => {
    expect(__test__.tlsInsecureEnabled()).toBe(false)
  })

  it('recognizes the explicit user-center self-signed opt-in', () => {
    process.env.MC_USERCENTER_TLS_INSECURE = 'true'
    expect(__test__.tlsInsecureEnabled()).toBe(true)
  })

  it('uses normal fetch for HTTP even when the TLS opt-in is enabled', async () => {
    process.env.MC_USERCENTER_TLS_INSECURE = '1'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
    await userCenterFetch('http://user-center.internal/health')
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
