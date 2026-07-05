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

  it('matches Chinese confirmation after idle (你确认后)', () => {
    const result = evaluateHumanWatchRules(
      [
        {
          role: 'assistant',
          content:
            '当前环境是只读的，我不能直接创建文件。你确认后，我可以直接给你一个完整的单文件 index.html。',
          createdAt: now - 120,
        },
      ],
      { idle_timeout_seconds: 60, require_combination: true },
      now,
    )
    expect(result.matched).toBe(true)
    expect(result.rulesHit.confirmation_text).toBe(true)
    expect(result.rulesHit.idle_timeout).toBe(true)
  })

  it('uses shorter idle when stuck signal present', () => {
    const result = evaluateHumanWatchRules(
      [
        {
          role: 'assistant',
          content: '请确认是否继续。',
          createdAt: now - 30,
        },
      ],
      {
        idle_timeout_seconds: 90,
        idle_timeout_with_stuck_seconds: 25,
        require_combination: true,
      },
      now,
    )
    expect(result.matched).toBe(true)
    expect(result.rulesHit.confirmation_text).toBe(true)
    expect(result.rulesHit.idle_timeout).toBe(true)
  })

  it('matches awaiting user response question after idle', () => {
    const result = evaluateHumanWatchRules(
      [
        {
          role: 'assistant',
          content: '我可以继续处理这个问题。你希望我先检查服务端日志还是本地托盘日志？',
          createdAt: now - 120,
        },
      ],
      { idle_timeout_seconds: 60, require_combination: true },
      now,
    )
    expect(result.matched).toBe(true)
    expect(result.rulesHit.awaiting_user_response).toBe(true)
    expect(result.rulesHit.idle_timeout).toBe(true)
  })

  it('matches strong signal when transcript has no timestamps', () => {
    const result = evaluateHumanWatchRules(
      [{ role: 'assistant', content: '你确认后我再继续。' }],
      { require_combination: true, match_when_stuck_without_timestamps: true },
      now,
    )
    expect(result.matched).toBe(true)
    expect(result.rulesHit.confirmation_strong).toBe(true)
    expect(result.rulesHit.idle_unknown_timestamps).toBe(true)
  })

  it('does not match when user already replied after assistant question', () => {
    const result = evaluateHumanWatchRules(
      [
        { role: 'assistant', content: '请确认是否继续。', createdAt: now - 120 },
        { role: 'user', content: '好的', createdAt: now - 60 },
      ],
      { idle_timeout_seconds: 30, require_combination: true },
      now,
    )
    expect(result.matched).toBe(false)
    expect(result.reason).toBe('awaiting_user_reply')
  })

  it('does not match weak-only phrase in non-final assistant message', () => {
    const result = evaluateHumanWatchRules(
      [
        { role: 'assistant', content: '下一步怎么做还需要分析。', createdAt: now - 120 },
        { role: 'assistant', content: '已完成分析。', createdAt: now - 90 },
      ],
      { idle_timeout_seconds: 30, idle_timeout_with_stuck_seconds: 20, require_combination: true },
      now,
    )
    expect(result.matched).toBe(false)
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
