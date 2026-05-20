import { describe, expect, it } from 'vitest'
import {
  buildStewardJudgePrompt,
  buildWorkerSummaryForJudge,
  parseStewardConfigFromAgent,
} from '@/lib/human-watch-judge'

describe('human-watch-judge', () => {
  it('parses steward config from agent.config JSON', () => {
    const config = parseStewardConfigFromAgent({
      config: JSON.stringify({
        steward: {
          llm_enabled: true,
          llm_sweep_enabled: true,
          llm_sweep_interval_minutes: 15,
          judge_prompt_template: 'Judge: {summary}',
          context: { summary_max_messages: 8 },
        },
      }),
    })
    expect(config.llm_enabled).toBe(true)
    expect(config.llm_sweep_enabled).toBe(true)
    expect(config.llm_sweep_interval_minutes).toBe(15)
    expect(config.judge_prompt_template).toBe('Judge: {summary}')
    expect(config.context?.summary_max_messages).toBe(8)
  })

  it('builds worker summary from transcript messages', () => {
    const summary = buildWorkerSummaryForJudge(
      [
        { role: 'user', parts: [{ type: 'text', text: 'Hello' }], timestamp: '2026-01-01T00:00:00Z' },
        { role: 'assistant', parts: [{ type: 'text', text: 'Working on it' }], timestamp: '2026-01-01T00:01:00Z' },
      ],
      { summary_max_messages: 10 },
    )
    expect(summary).toContain('USER:')
    expect(summary).toContain('ASSISTANT:')
  })

  it('substitutes summary into judge prompt template', () => {
    const prompt = buildStewardJudgePrompt('line-1', { judge_prompt_template: 'Go: {summary}' })
    expect(prompt).toBe('Go: line-1')
  })
})
