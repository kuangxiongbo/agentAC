import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const executeBoundLocalAgentPrompt = vi.fn()
const getLocalSessionKindForFramework = vi.fn((framework: string | null) => {
  if (framework === 'claude') return 'claude-code'
  if (framework === 'codex') return 'codex-cli'
  return null
})
const readLocalSessionTranscriptPage = vi.fn()

let agentRow: Record<string, unknown> | undefined

const prepare = vi.fn((sql: string) => {
  if (sql.includes('FROM agents') && sql.includes('WHERE id = ?')) {
    return { get: vi.fn(() => agentRow) }
  }
  return { get: vi.fn(), run: vi.fn() }
})

vi.mock('@/lib/db', () => ({
  getDatabase: vi.fn(() => ({ prepare })),
}))

vi.mock('@/lib/local-session-executor', () => ({
  executeBoundLocalAgentPrompt,
  getLocalSessionKindForFramework,
}))

vi.mock('@/lib/session-transcript', () => ({
  readLocalSessionTranscriptPage,
}))

describe('human-watch-judge', () => {
  beforeEach(() => {
    vi.stubEnv('OPENAI_API_KEY', '')
    vi.resetModules()
    executeBoundLocalAgentPrompt.mockReset()
    getLocalSessionKindForFramework.mockClear()
    readLocalSessionTranscriptPage.mockReset()
    prepare.mockClear()
    agentRow = {
      id: 9,
      name: '值守云端',
      role: 'human-watch',
      soul_content: '只输出一条可直接发给 Worker 的用户消息。',
      framework: 'claude',
      session_key: null,
      config: JSON.stringify({ agent_kind: 'human_watch' }),
      workspace_path: null,
      source: 'manual',
      parent_id: null,
      status: 'idle',
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('uses the structured fast judge without growing the steward CLI session', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key')
    vi.stubEnv('MC_HUMAN_WATCH_FAST_JUDGE_BASE_URL', 'https://model.example/v1')
    vi.stubEnv('MC_HUMAN_WATCH_FAST_JUDGE_MODEL', 'fast-test-model')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            action: 'reply',
            reply: '选择简洁版。',
            reason: '用户要求二选一',
            risk: 'normal',
          }),
        },
      }],
      usage: { prompt_tokens: 120, completion_tokens: 24 },
    }), { status: 200 }))

    const { runStewardJudgeOnEdge } = await import('@/lib/human-watch-judge')
    const result = await runStewardJudgeOnEdge(9, 'Worker 询问使用简洁版还是详细版。')

    expect(result.reply).toContain('选择简洁版')
    expect(result.sessionId).toBe('')
    expect(executeBoundLocalAgentPrompt).not.toHaveBeenCalled()
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO token_usage'))
    expect(fetchMock).toHaveBeenCalledWith(
      'https://model.example/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('falls back to the steward CLI when the fast judge fails', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key')
    vi.stubEnv('MC_HUMAN_WATCH_FAST_JUDGE_BASE_URL', 'https://model.example')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }))
    executeBoundLocalAgentPrompt.mockResolvedValue({
      reply: '确认继续。',
      sessionId: 'fallback-session',
    })

    const { runStewardJudgeOnEdge } = await import('@/lib/human-watch-judge')
    const result = await runStewardJudgeOnEdge(9, 'Worker 等待确认。')

    expect(result).toEqual({ reply: '确认继续。', sessionId: 'fallback-session' })
    expect(executeBoundLocalAgentPrompt).toHaveBeenCalledOnce()
  })

  it('auto-provisions a dedicated judge session when the steward has no session_key', async () => {
    executeBoundLocalAgentPrompt.mockResolvedValue({
      reply: '继续执行下一步。',
      sessionId: 'new-judge-session',
    })

    const { runStewardJudgeOnEdge } = await import('@/lib/human-watch-judge')
    const result = await runStewardJudgeOnEdge(9, 'Worker 需要确认下一步。')

    expect(executeBoundLocalAgentPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ id: 9, session_key: null, role: 'human-watch' }),
      'Worker 需要确认下一步。',
      expect.objectContaining({ timeoutMs: 600000 }),
    )
    expect(result).toEqual({
      reply: '继续执行下一步。',
      sessionId: 'new-judge-session',
    })
  })

  it('rejects CLI runtime errors instead of returning them as steward replies', async () => {
    executeBoundLocalAgentPrompt.mockResolvedValue({
      reply: 'Missing environment variable: `OPENAI_API_KEY`.',
      sessionId: 'new-judge-session',
    })

    const { runStewardJudgeOnEdge } = await import('@/lib/human-watch-judge')

    await expect(runStewardJudgeOnEdge(9, 'Worker 需要确认下一步。'))
      .rejects
      .toThrow('Judge session returned runtime error')
  })

  it('accepts repeated steward text when a new assistant message was added', async () => {
    agentRow = {
      ...agentRow,
      framework: 'codex',
      session_key: 'judge-session-1',
    }
    readLocalSessionTranscriptPage
      .mockReturnValueOnce({
        messages: [
          { role: 'assistant', parts: [{ type: 'text', text: '继续' }] },
        ],
      })
      .mockReturnValueOnce({
        messages: [
          { role: 'assistant', parts: [{ type: 'text', text: '继续' }] },
          { role: 'user', parts: [{ type: 'text', text: 'judge prompt' }] },
          { role: 'assistant', parts: [{ type: 'text', text: '继续' }] },
        ],
      })
    executeBoundLocalAgentPrompt.mockResolvedValue({
      reply: '继续',
      sessionId: 'judge-session-1',
    })

    const { runStewardJudgeOnEdge } = await import('@/lib/human-watch-judge')
    const result = await runStewardJudgeOnEdge(9, 'Worker 需要确认下一步。')

    expect(result).toEqual({
      reply: '继续',
      sessionId: 'judge-session-1',
    })
  })

  it('accepts repeated steward text when the paged assistant count is unchanged but timestamp is newer', async () => {
    agentRow = {
      ...agentRow,
      framework: 'codex',
      session_key: 'judge-session-1',
    }
    readLocalSessionTranscriptPage
      .mockReturnValueOnce({
        messages: [
          { role: 'assistant', timestamp: '2026-07-07T06:00:17.693Z', parts: [{ type: 'text', text: '继续' }] },
          { role: 'user', timestamp: '2026-07-07T06:01:15.223Z', parts: [{ type: 'text', text: 'old prompt' }] },
          { role: 'assistant', timestamp: '2026-07-07T06:01:20.462Z', parts: [{ type: 'text', text: '继续' }] },
        ],
      })
      .mockReturnValueOnce({
        messages: [
          { role: 'assistant', timestamp: '2026-07-07T06:01:20.462Z', parts: [{ type: 'text', text: '继续' }] },
          { role: 'user', timestamp: '2026-07-07T06:02:15.246Z', parts: [{ type: 'text', text: 'new prompt' }] },
          { role: 'assistant', timestamp: '2026-07-07T06:02:25.304Z', parts: [{ type: 'text', text: '继续' }] },
        ],
      })
    executeBoundLocalAgentPrompt.mockResolvedValue({
      reply: '继续',
      sessionId: 'judge-session-1',
    })

    const { runStewardJudgeOnEdge } = await import('@/lib/human-watch-judge')
    const result = await runStewardJudgeOnEdge(9, 'Worker 需要确认下一步。')

    expect(result).toEqual({
      reply: '继续',
      sessionId: 'judge-session-1',
    })
  })
})
