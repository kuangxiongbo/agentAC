import { beforeEach, describe, expect, it, vi } from 'vitest'

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
    )
    expect(result).toEqual({
      reply: '继续执行下一步。',
      sessionId: 'new-judge-session',
    })
  })
})
