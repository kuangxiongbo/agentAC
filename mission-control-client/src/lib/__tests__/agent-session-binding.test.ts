import { describe, expect, it } from 'vitest'
import {
  getAgentLocalSessionKind,
  validateAgentSessionKindBinding,
} from '@/lib/agent-session-binding'

describe('agent-session-binding', () => {
  it('maps agent frameworks to session kinds', () => {
    expect(getAgentLocalSessionKind('claude')).toBe('claude-code')
    expect(getAgentLocalSessionKind('codex')).toBe('codex-cli')
    expect(getAgentLocalSessionKind('openclaw')).toBeNull()
  })

  it('allows matching claude agent and session', () => {
    expect(validateAgentSessionKindBinding('claude', 'claude-code')).toEqual({ ok: true })
  })

  it('rejects claude agent on codex session', () => {
    const result = validateAgentSessionKindBinding('claude', 'codex-cli')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toMatch(/Claude/i)
      expect(result.message).toMatch(/Codex/i)
    }
  })

  it('rejects codex agent on claude session', () => {
    const result = validateAgentSessionKindBinding('codex', 'claude-code')
    expect(result.ok).toBe(false)
  })
})
