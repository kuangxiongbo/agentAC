import { describe, expect, it } from 'vitest'
import {
  buildStewardJudgePrompt,
  buildFastStewardJudgePrompt,
  buildWorkerJudgeContext,
  buildWorkerSummaryForJudge,
  classifyDangerousWorkerRequest,
  parseStewardJudgeDecision,
  parseStewardConfigFromAgent,
} from '@/lib/human-watch-judge'

describe('human-watch-judge', () => {
  it('parses structured reply, ask-worker, and human-escalation decisions', () => {
    expect(parseStewardJudgeDecision('{"action":"reply","reply":"选择 PDF，确认。","reason":"用户偏好已知","risk":"normal"}'))
      .toMatchObject({ action: 'reply', reply: '选择 PDF，确认。', structured: true })
    expect(parseStewardJudgeDecision('```json\n{"action":"ask_worker","reply":"请汇报失败日志的关键错误。","reason":"缺少日志","risk":"normal"}\n```'))
      .toMatchObject({ action: 'ask_worker', structured: true })
    expect(parseStewardJudgeDecision('{"action":"escalate_human","reply":"","reason":"需业务负责人决定","risk":"high"}'))
      .toMatchObject({ action: 'escalate_human', risk: 'high', structured: true })
  })

  it('keeps backward compatibility for legacy plain-text judge replies', () => {
    expect(parseStewardJudgeDecision('补充客户名称后继续。')).toEqual({
      action: 'reply',
      reply: '补充客户名称后继续。',
      reason: 'legacy_plain_text_reply',
      risk: 'normal',
      structured: false,
    })
  })

  it('classifies destructive, production, privilege, and secret requests', () => {
    const message = (text: string) => [{ role: 'assistant' as const, parts: [{ type: 'text' as const, text }] }]
    expect(classifyDangerousWorkerRequest(message('请确认是否删除生产数据库。'))).toBeTruthy()
    expect(classifyDangerousWorkerRequest(message('请确认是否继续部署生产环境。'))).toBeTruthy()
    expect(classifyDangerousWorkerRequest(message('请提供 root 权限并执行 sudo。'))).toBeTruthy()
    expect(classifyDangerousWorkerRequest(message('请发送 API key 后继续。'))).toBeTruthy()
    expect(classifyDangerousWorkerRequest(message('最终验收报告选择 PDF 还是 DOCX？'))).toBeNull()
  })

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

  it('bounds generated judge prompt for edge executor limits', () => {
    const prompt = buildStewardJudgePrompt('summary\n'.repeat(1200), 'context\n'.repeat(900), {})
    expect(prompt.length).toBeLessThanOrEqual(5900)
    expect(prompt).toContain('[truncated]')
  })

  it('builds a bounded fast judge prompt with context, memory, and recent transcript', () => {
    const prompt = buildFastStewardJudgePrompt(
      'recent transcript\n'.repeat(200),
      'worker context\n'.repeat(200),
      'approved memory\n'.repeat(200),
    )
    expect(prompt.length).toBeLessThanOrEqual(1600)
    expect(prompt).toContain('受控记忆')
    expect(prompt).toContain('最近会话')
    expect(prompt).toContain('[truncated]')
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
