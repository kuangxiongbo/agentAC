import os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readSystemUptimeSeconds, runSecurityScan } from '@/lib/security-scan'

describe('readSystemUptimeSeconds', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns null when uptime is unavailable', () => {
    vi.spyOn(os, 'uptime').mockImplementation(() => {
      throw new Error('EPERM')
    })

    expect(readSystemUptimeSeconds()).toBeNull()
  })

  it('returns uptime when available', () => {
    vi.spyOn(os, 'uptime').mockReturnValue(123)

    expect(readSystemUptimeSeconds()).toBe(123)
  })
})

describe('runSecurityScan', () => {
  it('reuses recent scans and supports a forced refresh', () => {
    const first = runSecurityScan({ force: true })
    const cached = runSecurityScan()
    const refreshed = runSecurityScan({ force: true })

    expect(cached).toBe(first)
    expect(refreshed).not.toBe(first)
  })
})
