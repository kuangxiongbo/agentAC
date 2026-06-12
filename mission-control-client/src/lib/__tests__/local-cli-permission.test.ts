import { describe, expect, it } from 'vitest'

describe('local-cli-permission', () => {
  it('parses permission aliases', async () => {
    const mod = await import('@/lib/local-cli-permission')
    expect(mod.parseLocalCliPermissionMode('full')).toBe('full')
    expect(mod.parseLocalCliPermissionMode('standard')).toBe('standard')
    expect(mod.parseLocalCliPermissionMode('nope')).toBeNull()
  })

  it('uses explicit per-request mode only', async () => {
    const mod = await import('@/lib/local-cli-permission')
    expect(mod.resolveLocalCliPermissionMode(null, 'full')).toBe('full')
    expect(mod.resolveLocalCliPermissionMode({ config: { mc_local_cli_permission: 'full' } })).toBe('standard')
  })

  it('adds elevated CLI flags in full mode', async () => {
    const mod = await import('@/lib/local-cli-permission')
    expect(mod.withLocalCliPermissionArgs('codex', ['exec', 'hi'], 'full')).toEqual([
      'exec',
      'hi',
      '--dangerously-bypass-approvals-and-sandbox',
    ])
    expect(mod.withLocalCliPermissionArgs('claude', ['--print'], 'full')).toEqual([
      '--print',
      '--dangerously-skip-permissions',
    ])
  })
})
