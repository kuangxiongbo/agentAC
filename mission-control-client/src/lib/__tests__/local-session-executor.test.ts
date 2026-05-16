import { beforeEach, describe, expect, it, vi } from 'vitest'

const runCommand = vi.fn()
const scanCodexSessions = vi.fn()

let agentRow: any = null

const getMock = vi.fn((id?: number) => {
  if (!agentRow) return undefined
  if (typeof id === 'number' && agentRow.id !== id) return undefined
  return { ...agentRow }
})

const runUpdate = vi.fn((sessionKey: string | null, config: string, status: string, _updatedAt: number, id: number) => {
  if (!agentRow || agentRow.id !== id) return
  agentRow = {
    ...agentRow,
    session_key: sessionKey,
    config,
    status,
  }
})

const prepare = vi.fn((sql: string) => {
  if (sql.includes('FROM agents') && sql.includes('WHERE id = ?')) {
    return { get: getMock }
  }
  if (sql.includes('UPDATE agents') && sql.includes('SET session_key = ?')) {
    return { run: runUpdate }
  }
  return {
    get: vi.fn(),
    run: vi.fn(),
  }
})

const getDatabase = vi.fn(() => ({ prepare }))

vi.mock('@/lib/command', () => ({
  runCommand,
}))

vi.mock('@/lib/codex-sessions', () => ({
  scanCodexSessions,
}))

vi.mock('@/lib/db', () => ({
  getDatabase,
}))

describe('local-session-executor', () => {
  beforeEach(() => {
    vi.resetModules()
    runCommand.mockReset()
    scanCodexSessions.mockReset()
    getDatabase.mockClear()
    prepare.mockClear()
    getMock.mockClear()
    runUpdate.mockClear()
    agentRow = null
  })

  it('maps frameworks to local session kinds', async () => {
    const { getLocalSessionKindForFramework } = await import('@/lib/local-session-executor')
    expect(getLocalSessionKindForFramework('claude')).toBe('claude-code')
    expect(getLocalSessionKindForFramework('claude-sdk')).toBe('claude-code')
    expect(getLocalSessionKindForFramework('codex')).toBe('codex-cli')
    expect(getLocalSessionKindForFramework('cursor')).toBe('cursor')
    expect(getLocalSessionKindForFramework('opencode')).toBe('opencode')
    expect(getLocalSessionKindForFramework('hermes')).toBe('hermes')
    expect(getLocalSessionKindForFramework('openclaw')).toBeNull()
  })

  it('rejects invalid session ids', async () => {
    const { executeLocalSessionPrompt } = await import('@/lib/local-session-executor')
    await expect(executeLocalSessionPrompt('claude-code', 'bad session', 'hello')).rejects.toThrow('Invalid session id')
  })

  it('executes a claude local session prompt', async () => {
    runCommand.mockResolvedValue({ stdout: 'done', stderr: '', code: 0 })
    const { executeLocalSessionPrompt } = await import('@/lib/local-session-executor')
    const result = await executeLocalSessionPrompt('claude-code', 'claude-session-1', 'hello')
    expect(runCommand).toHaveBeenCalledWith('claude', ['--print', '--resume', 'claude-session-1', 'hello'], { timeoutMs: 180000 })
    expect(result.reply).toBe('done')
  })

  it('executes a cursor local session prompt via the cursor agent CLI', async () => {
    runCommand.mockResolvedValue({
      stdout: '{"type":"result","sessionId":"cursor-session-1","result":"cursor-done"}',
      stderr: '',
      code: 0,
    })
    const { executeLocalSessionPrompt } = await import('@/lib/local-session-executor')
    const result = await executeLocalSessionPrompt('cursor', 'cursor-session-1', 'hello')
    expect(runCommand).toHaveBeenCalledWith(
      'cursor',
      ['agent', '--print', '--output-format', 'json', '--force', '--trust', '--resume', 'cursor-session-1', 'hello'],
      { timeoutMs: 180000 },
    )
    expect(result.reply).toBe('cursor-done')
  })

  it('executes a hermes local session prompt via resumed chat', async () => {
    runCommand.mockResolvedValue({ stdout: 'hermes-done', stderr: '', code: 0 })
    const { executeLocalSessionPrompt } = await import('@/lib/local-session-executor')
    const result = await executeLocalSessionPrompt('hermes', 'hermes-session-1', 'hello')
    expect(runCommand).toHaveBeenCalledWith(
      'hermes',
      ['chat', '--quiet', '--query', 'hello', '--resume', 'hermes-session-1'],
      { timeoutMs: 180000 },
    )
    expect(result.reply).toBe('hermes-done')
  })

  it('falls back to legacy opencode prompt mode when session run is unavailable', async () => {
    runCommand
      .mockResolvedValueOnce({ stdout: 'Usage:\n  opencode [flags]\n', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '{"text":"opencode-done"}', stderr: '', code: 0 })
    const { executeLocalSessionPrompt } = await import('@/lib/local-session-executor')
    const result = await executeLocalSessionPrompt('opencode', 'opencode-session-1', 'hello')
    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      'opencode',
      ['run', '--help'],
      { timeoutMs: 3000 },
    )
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      'opencode',
      ['-q', '-p', 'hello', '-f', 'json'],
      { timeoutMs: 180000 },
    )
    expect(result.reply).toBe('opencode-done')
  })

  it('uses opencode session run when the installed CLI supports it', async () => {
    runCommand
      .mockResolvedValueOnce({ stdout: 'Usage: opencode run [message..]\n  --session\n', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '{"text":"opencode-run-done","sessionID":"opencode-session-1"}', stderr: '', code: 0 })
    const { executeLocalSessionPrompt } = await import('@/lib/local-session-executor')
    const result = await executeLocalSessionPrompt('opencode', 'opencode-session-1', 'hello')
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      'opencode',
      ['run', '--session', 'opencode-session-1', '--format', 'json', 'hello'],
      { timeoutMs: 180000 },
    )
    expect(result.reply).toBe('opencode-run-done')
  })

  it('auto provisions and persists a dedicated claude session for a child agent', async () => {
    runCommand
      .mockResolvedValueOnce({ stdout: 'READY', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'claude-initial-reply', stderr: '', code: 0 })
    agentRow = {
      id: 7,
      name: 'frontend',
      framework: 'claude',
      session_key: null,
      config: JSON.stringify({ session_mode: 'dedicated', session_state: 'pending' }),
      workspace_path: null,
      source: 'user',
      parent_id: 3,
      status: 'offline',
    }

    const { executeBoundLocalAgentPrompt } = await import('@/lib/local-session-executor')
    const result = await executeBoundLocalAgentPrompt(agentRow, 'hello')

    expect(runCommand).toHaveBeenCalledTimes(2)
    const [, bootstrapArgs] = runCommand.mock.calls[0]
    expect(bootstrapArgs[0]).toBe('--print')
    expect(bootstrapArgs[1]).toBe('--session-id')
    expect(String(bootstrapArgs[3])).toContain('E-Agent-Client dedicated-session bootstrap')
    const [, messageArgs] = runCommand.mock.calls[1]
    expect(messageArgs[0]).toBe('--print')
    expect(messageArgs[1]).toBe('--resume')
    expect(messageArgs[3]).toBe('hello')
    expect(result.reply).toBe('claude-initial-reply')
    expect(result.sessionId).toMatch(/[0-9a-f-]{36}/)
    expect(runUpdate).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.stringContaining('"session_state":"ready"'),
      'idle',
      expect.any(Number),
      7,
    )
  })

  it('does not auto provision runtime-managed anchor agents', async () => {
    agentRow = {
      id: 9,
      name: 'Claude Code (Main)',
      framework: 'claude',
      session_key: null,
      config: JSON.stringify({ runtime_managed: true, session_mode: 'dedicated', session_state: 'pending' }),
      workspace_path: null,
      source: 'runtime',
      parent_id: null,
      status: 'idle',
    }

    const { executeBoundLocalAgentPrompt } = await import('@/lib/local-session-executor')
    await expect(executeBoundLocalAgentPrompt(agentRow, 'hello')).rejects.toThrow('Recipient agent has no session key configured')
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('reprovisions a dedicated claude session when the stored session key is invalid', async () => {
    const invalidResumeError = new Error('Error: --resume requires a valid session ID or session title when used with --print. Provided value "fr001" is not a UUID and does not match any session title.')
    runCommand
      .mockRejectedValueOnce(invalidResumeError)
      .mockResolvedValueOnce({ stdout: 'READY', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'claude-rebound', stderr: '', code: 0 })
    agentRow = {
      id: 10,
      name: 'frontend',
      framework: 'claude',
      session_key: 'fr001',
      config: JSON.stringify({}),
      workspace_path: null,
      source: 'user',
      parent_id: 3,
      status: 'offline',
    }

    const { executeBoundLocalAgentPrompt } = await import('@/lib/local-session-executor')
    const result = await executeBoundLocalAgentPrompt(agentRow, 'hello')

    expect(runCommand).toHaveBeenCalledTimes(3)
    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      'claude',
      ['--print', '--resume', 'fr001', expect.stringContaining('E-Agent-Client dedicated-session bootstrap')],
      { timeoutMs: 180000 },
    )
    const [, secondArgs] = runCommand.mock.calls[1]
    expect(secondArgs[0]).toBe('--print')
    expect(secondArgs[1]).toBe('--session-id')
    expect(String(secondArgs[3])).toContain('E-Agent-Client dedicated-session bootstrap')
    const [, thirdArgs] = runCommand.mock.calls[2]
    expect(thirdArgs[0]).toBe('--print')
    expect(thirdArgs[1]).toBe('--resume')
    expect(thirdArgs[3]).toBe('hello')
    expect(result.reply).toBe('claude-rebound')
    expect(runUpdate).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.stringContaining('"session_state":"ready"'),
      'idle',
      expect.any(Number),
      10,
    )
  })

  it('auto provisions codex and binds the detected new session id', async () => {
    scanCodexSessions
      .mockReturnValueOnce([
        { sessionId: 'old-session', projectPath: '/tmp', lastMessageAt: new Date(Date.now() - 60000).toISOString() },
      ])
      .mockReturnValueOnce([
        { sessionId: 'new-session', projectPath: '/tmp', lastMessageAt: new Date().toISOString() },
      ])
    runCommand.mockResolvedValue({ stdout: '{"text":"codex-new-reply"}', stderr: '', code: 0 })
    agentRow = {
      id: 11,
      name: 'backend',
      framework: 'codex',
      session_key: null,
      config: JSON.stringify({ session_mode: 'dedicated', session_state: 'pending' }),
      workspace_path: '/tmp',
      source: 'user',
      parent_id: 4,
      status: 'offline',
    }

    const { executeBoundLocalAgentPrompt } = await import('@/lib/local-session-executor')
    const result = await executeBoundLocalAgentPrompt(agentRow, 'hello')

    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      'codex',
      ['exec', expect.stringContaining('E-Agent-Client dedicated-session bootstrap'), '--skip-git-repo-check', '--json', '-o', expect.stringMatching(/^\/tmp\/mc-codex-start-/)],
      { timeoutMs: 180000, cwd: '/tmp' },
    )
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      'codex',
      ['exec', 'resume', 'new-session', 'hello', '--skip-git-repo-check', '-o', expect.stringMatching(/^\/tmp\/mc-codex-last-/)],
      { timeoutMs: 180000, cwd: '/tmp' },
    )
    expect(result.sessionId).toBe('new-session')
    expect(runUpdate).toHaveBeenLastCalledWith(
      'new-session',
      expect.stringContaining('"primary_session_key":"new-session"'),
      'idle',
      expect.any(Number),
      11,
    )
  })
})
