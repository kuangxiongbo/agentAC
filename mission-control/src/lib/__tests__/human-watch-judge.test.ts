import { describe, expect, it } from 'vitest'
import {
  buildStewardJudgePrompt,
  buildWorkerJudgeContext,
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

  it('forces llm_enabled for human-watch steward agents', () => {
    const config = parseStewardConfigFromAgent({
      role: 'human-watch',
      config: JSON.stringify({ agent_kind: 'human_watch', steward: { llm_enabled: false } }),
    })
    expect(config.llm_enabled).toBe(true)
  })

  it('substitutes summary into judge prompt template', () => {
    const prompt = buildStewardJudgePrompt('line-1', 'ctx-1', {
      judge_prompt_template: 'Go: {context} // {summary}',
    })
    expect(prompt).toBe('Go: ctx-1 // line-1')
  })

  it('builds structured worker judge context', () => {
    const ctx = buildWorkerJudgeContext(
      [
        { role: 'user', parts: [{ type: 'text', text: '请继续排查端口占用问题' }], timestamp: '2026-01-01T00:00:00Z' },
        { role: 'assistant', parts: [{ type: 'text', text: '[tool_result] lsof 显示 5101 被占用' }], timestamp: '2026-01-01T00:02:00Z' },
        { role: 'assistant', parts: [{ type: 'text', text: '我当前受阻，请确认是否继续 kill 旧进程。' }], timestamp: '2026-01-01T00:03:00Z' },
      ],
      {},
    )
    expect(ctx).toContain('最近用户意图')
    expect(ctx).toContain('最近 Assistant 输出')
    expect(ctx).toContain('最近工具结果')
    expect(ctx).toContain('推断待解决问题')
    expect(ctx).toContain('等待确认或选择')
  })
})
