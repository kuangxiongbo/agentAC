import { describe, expect, it } from 'vitest'

describe('gateway-sync human-watch role normalization', () => {
  it('preserves human-watch role for steward agents', async () => {
    const source = await import('@/lib/gateway-sync')
    const normalize = (source as unknown as { normalizeRemoteRegisterRole?: (role: string) => string }).normalizeRemoteRegisterRole
    expect(typeof normalize).toBe('function')
    expect(normalize?.('human-watch')).toBe('human-watch')
    expect(normalize?.('human_watch')).toBe('human-watch')
  })
})
