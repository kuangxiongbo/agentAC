import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  isValidInstallerSha256,
  resolvePinnedOpenClawSpec,
  resolvePinnedNpmRuntimeSpec,
  runtimeInstallsEnabled,
  verifyInstallerSha256,
} from '../runtime-install-security'

describe('runtime install security', () => {
  it('keeps dashboard-triggered installs disabled by default', () => {
    expect(runtimeInstallsEnabled({})).toBe(false)
    expect(runtimeInstallsEnabled({ MC_ENABLE_RUNTIME_INSTALLS: 'true' })).toBe(false)
    expect(runtimeInstallsEnabled({ MC_ENABLE_RUNTIME_INSTALLS: '1' })).toBe(true)
  })

  it('requires a complete SHA-256 digest and compares it safely', () => {
    const content = Buffer.from('reviewed installer')
    const digest = createHash('sha256').update(content).digest('hex')
    expect(isValidInstallerSha256(digest)).toBe(true)
    expect(isValidInstallerSha256('abc')).toBe(false)
    expect(verifyInstallerSha256(content, digest).valid).toBe(true)
    expect(verifyInstallerSha256(Buffer.from('changed'), digest).valid).toBe(false)
  })

  it('requires exact Claude and Codex versions', () => {
    expect(resolvePinnedNpmRuntimeSpec('claude', { MC_CLAUDE_CODE_VERSION: '2.1.71' }))
      .toEqual({ spec: '@anthropic-ai/claude-code@2.1.71' })
    expect(resolvePinnedNpmRuntimeSpec('codex', { MC_CODEX_VERSION: '0.115.0' }))
      .toEqual({ spec: '@openai/codex@0.115.0' })
    expect(resolvePinnedNpmRuntimeSpec('claude', { MC_CLAUDE_CODE_VERSION: 'latest' }))
      .toEqual({ error: 'MC_CLAUDE_CODE_VERSION must be an exact semantic version' })
    expect(resolvePinnedNpmRuntimeSpec('codex', {}))
      .toEqual({ error: 'MC_CODEX_VERSION must be an exact semantic version' })
  })

  it('pins per-user OpenClaw installs to a reviewed commit', () => {
    const commit = 'a'.repeat(40)
    expect(resolvePinnedOpenClawSpec({ MC_OPENCLAW_GIT_COMMIT: commit }))
      .toEqual({ spec: `github:openclaw/openclaw#${commit}` })
    expect(resolvePinnedOpenClawSpec({ MC_OPENCLAW_GIT_COMMIT: 'main' }))
      .toEqual({ error: 'MC_OPENCLAW_GIT_COMMIT must be a reviewed 40-character commit SHA' })
  })
})
