import { describe, expect, it } from 'vitest'
import { evaluateHumanWatchRules } from '@/lib/human-watch-rules'

describe('human-watch-rules', () => {
  const now = 1_700_000_000

  it('matches when idle and confirmation text present', () => {
    const result = evaluateHumanWatchRules(
      [
        { role: 'assistant', content: 'Please confirm which option you prefer.', createdAt: now - 120 },
      ],
      { idle_timeout_seconds: 60, require_combination: true },
      now,
    )
    expect(result.matched).toBe(true)
    expect(result.rulesHit.idle_timeout).toBe(true)
    expect(result.rulesHit.confirmation_text).toBe(true)
    expect(result.fingerprint).toHaveLength(24)
  })

  it('does not match when only idle without L2/L3', () => {
    const result = evaluateHumanWatchRules(
      [{ role: 'assistant', content: 'Done.', createdAt: now - 200 }],
      { idle_timeout_seconds: 60, require_combination: true },
      now,
    )
    expect(result.matched).toBe(false)
    expect(result.rulesHit.idle_timeout).toBe(true)
    expect(result.rulesHit.confirmation_text).toBeUndefined()
  })
})
