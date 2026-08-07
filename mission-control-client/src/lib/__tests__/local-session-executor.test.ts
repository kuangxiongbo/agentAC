import { beforeEach, describe, expect, it, vi } from 'vitest'
import { realpathSync } from 'node:fs'

const runCommand = vi.fn()
const scanCodexSessions = vi.fn()

let agentRow: any = null
let otherAgentsSessionKeys: Array<{ session_key: string }> = []

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
  if (sql.includes('SELECT session_key FROM agents')) {
    return { all: vi.fn(() => otherAgentsSessionKeys) }
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
  invalidateCodexSessionScan: vi.fn(),
}))

const findClaudeSessionProjectPath = vi.fn()
const findClaudeSessionFilePath = vi.fn()
const readLastClaudeSessionReply = vi.fn()
const syncClaudeSessions = vi.fn().mockResolvedValue({ ok: true, message: 'ok' })
const readLocalSessionTranscriptPage = vi.fn()

vi.mock('@/lib/claude-sessions', () => ({
  findClaudeSessionProjectPath,
  findClaudeSessionFilePath,
  readLastClaudeSessionReply,
  syncClaudeSessions,
  invalidateClaudeSessionSync: vi.fn(),
}))

vi.mock('@/lib/session-transcript', () => ({
  readLocalSessionTranscriptPage,
}))

vi.mock('@/lib/db', () => ({
  getDatabase,
}))

vi.mock('@/lib/session-realtime', () => ({
  notifySessionTranscriptUpdated: vi.fn(),
}))

const cmdOpts = (extra?: Record<string, unknown>) => expect.objectContaining({ timeoutMs: 180000, ...extra })
const probeOpts = () => expect.objectContaining({ timeoutMs: 3000 })

describe('local-session-executor', () => {
  beforeEach(() => {
    vi.resetModules()
    runCommand.mockReset()
    scanCodexSessions.mockReset()
    findClaudeSessionProjectPath.mockReset()
    findClaudeSessionFilePath.mockReset()
    readLastClaudeSessionReply.mockReset()
    syncClaudeSessions.mockReset().mockResolvedValue({ ok: true, message: 'ok' })
    readLocalSessionTranscriptPage.mockReset()
    otherAgentsSessionKeys = []
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
    expect(runCommand).toHaveBeenCalledWith('claude', ['--print', '--resume', 'claude-session-1', 'hello'], cmdOpts())
    expect(result.reply).toBe('done')
  })

  it('applies the intersection of agent and task sandbox limits', async () => {
    runCommand.mockResolvedValue({ stdout: 'sandboxed', stderr: '', code: 0 })
    agentRow = {
      id: 18,
      name: 'sandbox-worker',
      framework: 'claude',
      workspace_path: '/tmp',
      session_key: 'claude-session-18',
      config: JSON.stringify({
        session_mode: 'dedicated',
        session_state: 'ready',
        primary_session_key: 'claude-session-18',
        dispatchAllowedTools: ['Read', 'Write'],
        dispatchMaxBudgetUsd: 4,
        dispatchCwd: '.',
      }),
      status: 'idle',
    }

    const { executeBoundLocalAgentPrompt } = await import('@/lib/local-session-executor')
    const result = await executeBoundLocalAgentPrompt(agentRow, 'inspect safely', {
      dispatchAllowedTools: ['Read', 'Bash'],
      dispatchMaxBudgetUsd: 2,
      dispatchCwd: '.',
    })

    const [command, args, commandOptions] = runCommand.mock.calls[0]
    expect(command).toBe('claude')
    expect(args).toEqual(expect.arrayContaining([
      '--print', '--resume', 'claude-session-18',
      '--allowedTools', 'Read',
      '--max-budget-usd', '2',
    ]))
    expect(args.at(-1)).toContain('inspect safely')
    expect(commandOptions).toEqual(cmdOpts({ cwd: realpathSync('/tmp') }))
    expect(result.reply).toBe('sandboxed')
  })

  it('falls back to codex transcript reply when command returns no structured text', async () => {
    runCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 })
    readLocalSessionTranscriptPage.mockReturnValue({
      messages: [
        { role: 'assistant', parts: [{ type: 'text', text: 'judge recovered reply' }], timestamp: new Date().toISOString() },
      ],
    })

    const { executeLocalSessionPrompt } = await import('@/lib/local-session-executor')
    const result = await executeLocalSessionPrompt('codex-cli', 'codex-session-1', 'hello')

    expect(readLocalSessionTranscriptPage).toHaveBeenCalled()
    expect(result.reply).toBe('judge recovered reply')
  })

  it('resumes claude sessions using the JSONL project cwd when agent workspace differs', async () => {
    findClaudeSessionProjectPath.mockReturnValue('/tmp')
    runCommand.mockResolvedValue({ stdout: 'pong', stderr: '', code: 0 })

    const { createHash } = await import('node:crypto')
    const { resolveLocalExecutionWorkingDirectory, executeBoundLocalAgentPrompt } = await import('@/lib/local-session-executor')
    const roleHash = createHash('sha256')
      .update('Agent Name: 测试专家\nPrimary Role: quality reviewer\nPersona Marker: 🔬')
      .digest('hex')

    agentRow = {
      id: 33,
      name: '测试专家',
      framework: 'claude',
      workspace_path: '/Users/kuangxb/Desktop/test',
      session_key: 'e3fef5dd-d946-4f26-bd2c-aa5aa41240e8',
      config: JSON.stringify({
        identity: { theme: 'quality reviewer', emoji: '🔬' },
        session_mode: 'dedicated',
        session_strategy: 'persistent',
        session_state: 'ready',
        primary_session_key: 'e3fef5dd-d946-4f26-bd2c-aa5aa41240e8',
        session_bootstrap_state: 'ready',
        session_bootstrap_hash: roleHash,
        role_hash: roleHash,
      }),
      status: 'idle',
    }

    expect(
      resolveLocalExecutionWorkingDirectory(
        'claude-code',
        'e3fef5dd-d946-4f26-bd2c-aa5aa41240e8',
        agentRow,
        '/Users/kuangxb/Desktop/test',
      ),
    ).toBe('/tmp')

    await executeBoundLocalAgentPrompt(agentRow, 'hello from test')

    expect(findClaudeSessionProjectPath).toHaveBeenCalledWith('e3fef5dd-d946-4f26-bd2c-aa5aa41240e8')
    const [command, args, options] = runCommand.mock.calls[0]
    expect(command).toBe('claude')
    expect(args.slice(-4)).toEqual([
      '--print',
      '--resume',
      'e3fef5dd-d946-4f26-bd2c-aa5aa41240e8',
      'hello from test',
    ])
    const mcpConfig = JSON.parse(args[args.indexOf('--mcp-config') + 1])
    expect(mcpConfig.mcpServers.mission_control.env).toMatchObject({
      MC_AGENT_ID: '33',
      MC_WORKER_SESSION_ID: 'e3fef5dd-d946-4f26-bd2c-aa5aa41240e8',
      MC_SESSION_KIND: 'claude-code',
    })
    expect(options).toEqual(cmdOpts({ cwd: '/tmp' }))
  })

  it('resumes codex sessions using the persisted session project cwd', async () => {
    scanCodexSessions.mockReturnValue([
      {
        sessionId: '019ed56d-1f38-7983-b79c-87543322e549',
        projectPath: '/Users/kuangxb/.e-agent-client/agent-sessions/6',
      },
    ])
    runCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 })
    readLocalSessionTranscriptPage.mockReturnValue({
      messages: [
        { role: 'assistant', parts: [{ type: 'text', text: 'codex resumed' }], timestamp: new Date().toISOString() },
      ],
    })
    agentRow = {
      id: 6,
      name: 'security',
      framework: 'codex',
      workspace_path: '/tmp',
      session_key: '019ed56d-1f38-7983-b79c-87543322e549',
      config: JSON.stringify({
        session_mode: 'dedicated',
        session_state: 'ready',
        codex_model_provider: 'OpenAI3',
        primary_session_key: '019ed56d-1f38-7983-b79c-87543322e549',
        mc_session_project_path: '/Users/kuangxb/.e-agent-client/agent-sessions/6',
      }),
      status: 'idle',
    }

    const { resolveLocalExecutionWorkingDirectory, executeBoundLocalAgentPrompt } = await import('@/lib/local-session-executor')
    expect(
      resolveLocalExecutionWorkingDirectory(
        'codex-cli',
        '019ed56d-1f38-7983-b79c-87543322e549',
        agentRow,
        '/tmp',
      ),
    ).toBe('/Users/kuangxb/.e-agent-client/agent-sessions/6')

    await executeBoundLocalAgentPrompt(agentRow, 'resume codex')

    expect(runCommand).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([
        '-c',
        'model_provider="OpenAI3"',
        'exec',
        'resume',
        '019ed56d-1f38-7983-b79c-87543322e549',
        expect.stringContaining('resume codex'),
      ]),
      cmdOpts({ cwd: '/Users/kuangxb/.e-agent-client/agent-sessions/6' }),
    )
  })

  it('resumes mailbox codex sessions using the persisted agent project cwd', async () => {
    runCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 })
    readLocalSessionTranscriptPage.mockReturnValue({ messages: [] })
    agentRow = {
      id: 6,
      name: 'security',
      framework: 'codex',
      workspace_path: '/Users/kuangxb/.e-agent-edge/runtime/runtime',
      session_key: '019ed56d-1f38-7983-b79c-87543322e549',
      config: JSON.stringify({
        mc_session_project_path: '/tmp',
      }),
      status: 'idle',
    }

    const { enqueueLocalSessionPrompt } = await import('@/lib/local-session-executor')
    enqueueLocalSessionPrompt(
      'codex-cli',
      '019ed56d-1f38-7983-b79c-87543322e549',
      'resume mailbox codex',
      { agent: { id: 6 }, managedByPlatform: true },
    )

    await vi.waitFor(() => expect(runCommand).toHaveBeenCalled())
    expect(runCommand).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([
        'exec',
        'resume',
        '019ed56d-1f38-7983-b79c-87543322e549',
        expect.stringContaining('resume mailbox codex'),
      ]),
      cmdOpts({ cwd: '/tmp' }),
    )
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
      cmdOpts(),
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
      cmdOpts(),
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
      probeOpts(),
    )
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      'opencode',
      ['-q', '-p', 'hello', '-f', 'json'],
      cmdOpts(),
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
      cmdOpts(),
    )
    expect(result.reply).toBe('opencode-run-done')
  })

  it('auto provisions and persists a dedicated claude session for a child agent', async () => {
    runCommand.mockResolvedValueOnce({ stdout: 'claude-initial-reply', stderr: '', code: 0 })
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

    expect(runCommand).toHaveBeenCalledTimes(1)
    const [, startArgs] = runCommand.mock.calls[0]
    const printIndex = startArgs.indexOf('--print')
    expect(startArgs[printIndex + 1]).toBe('--session-id')
    expect(String(startArgs[printIndex + 3])).toContain('Now respond to the following user message in character:')
    expect(String(startArgs[printIndex + 3])).toContain('hello')
    const mcpConfig = JSON.parse(startArgs[startArgs.indexOf('--mcp-config') + 1])
    expect(mcpConfig.mcpServers.mission_control.env.MC_AGENT_ID).toBe('7')
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

  it('recovers a claude start from on-disk JSONL when the CLI exits non-zero', async () => {
    runCommand.mockRejectedValueOnce(new Error('Command failed (claude --print --session-id new-session hello): '))
    findClaudeSessionFilePath.mockReturnValue('/tmp/fake-session.jsonl')
    readLastClaudeSessionReply.mockReturnValue('recovered reply')

    agentRow = {
      id: 41,
      name: 'recover-me',
      framework: 'claude',
      session_key: null,
      config: JSON.stringify({ session_mode: 'dedicated', session_state: 'pending' }),
      workspace_path: '/tmp',
      status: 'idle',
    }

    const { executeBoundLocalAgentPrompt } = await import('@/lib/local-session-executor')
    const result = await executeBoundLocalAgentPrompt(agentRow, 'hello')

    expect(findClaudeSessionFilePath).toHaveBeenCalled()
    expect(result.reply).toBe('recovered reply')
    expect(runUpdate).toHaveBeenCalled()
    expect(syncClaudeSessions).toHaveBeenCalledWith(true)
  })

  it('reprovisions a dedicated claude session when the stored session key is invalid', async () => {
    const invalidResumeError = new Error('Error: --resume requires a valid session ID or session title when used with --print. Provided value "fr001" is not a UUID and does not match any session title.')
    runCommand
      .mockRejectedValueOnce(invalidResumeError)
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

    expect(runCommand).toHaveBeenCalledTimes(2)
    const [firstCommand, firstArgs, firstOptions] = runCommand.mock.calls[0]
    expect(firstCommand).toBe('claude')
    const firstPrintIndex = firstArgs.indexOf('--print')
    expect(firstArgs.slice(firstPrintIndex, firstPrintIndex + 3)).toEqual(['--print', '--resume', 'fr001'])
    expect(String(firstArgs[firstPrintIndex + 3])).toContain('Now respond to the following user message in character:')
    const firstMcpConfig = JSON.parse(firstArgs[firstArgs.indexOf('--mcp-config') + 1])
    expect(firstMcpConfig.mcpServers.mission_control.env).toMatchObject({
      MC_AGENT_ID: '10',
      MC_WORKER_SESSION_ID: 'fr001',
      MC_SESSION_KIND: 'claude-code',
    })
    expect(firstOptions).toEqual(cmdOpts())
    const [, secondArgs] = runCommand.mock.calls[1]
    const secondPrintIndex = secondArgs.indexOf('--print')
    expect(secondArgs[secondPrintIndex + 1]).toBe('--session-id')
    expect(String(secondArgs[secondPrintIndex + 3])).toContain('Now respond to the following user message in character:')
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
    const dedicatedCwd = expect.stringMatching(/agent-11|agent-sessions\/11/)
    let scanPass = 0
    scanCodexSessions.mockImplementation(() => {
      scanPass += 1
      if (scanPass === 1) {
        return [{
          sessionId: 'old-session',
          projectPath: '/tmp',
          firstMessageAt: new Date(Date.now() - 60000).toISOString(),
          lastMessageAt: new Date(Date.now() - 60000).toISOString(),
        }]
      }
      return [{
        sessionId: 'new-session',
        projectPath: '/tmp',
        firstMessageAt: new Date().toISOString(),
        lastMessageAt: new Date().toISOString(),
      }]
    })
    runCommand.mockResolvedValue({
      stdout: '{"type":"thread.started","thread_id":"new-session"}\n{"type":"item.completed","item":{"text":"codex-new-reply"}}',
      stderr: '',
      code: 0,
    })
    agentRow = {
      id: 11,
      name: 'backend',
      framework: 'codex',
      session_key: null,
      config: JSON.stringify({
        session_mode: 'dedicated',
        session_state: 'pending',
        codex_model_provider: 'OpenAI3',
      }),
      workspace_path: '/tmp',
      source: 'user',
      parent_id: 4,
      status: 'offline',
    }

    const { executeBoundLocalAgentPrompt } = await import('@/lib/local-session-executor')
    const result = await executeBoundLocalAgentPrompt(agentRow, 'hello')

    const codexBin = runCommand.mock.calls[0][0] as string
    expect(codexBin).toContain('codex')
    expect(runCommand).toHaveBeenCalledTimes(1)
    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      codexBin,
      [
        '-c',
        expect.stringContaining('mcp_servers.mission_control.command='),
        '-c',
        expect.stringContaining('mcp_servers.mission_control.args='),
        '-c',
        expect.stringContaining('mcp_servers.mission_control.env='),
        '-c',
        'model_provider="OpenAI3"',
        'exec',
        expect.stringContaining('Now respond to the following user message in character:'),
        '--skip-git-repo-check',
        '--json',
        '-o',
        expect.stringMatching(/^\/tmp\/mc-codex-start-/),
      ],
      cmdOpts({ cwd: dedicatedCwd }),
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

  it('reprovisions when session_key is already bound to another agent', async () => {
    otherAgentsSessionKeys = [{ session_key: 'shared-session' }]
    let scanCall = 0
    scanCodexSessions.mockImplementation(() => {
      scanCall += 1
      if (scanCall <= 2) {
        return [{ sessionId: 'shared-session', projectPath: '/tmp', lastMessageAt: new Date().toISOString() }]
      }
      return [
        { sessionId: 'shared-session', projectPath: '/tmp', lastMessageAt: new Date().toISOString() },
        { sessionId: 'fresh-session', projectPath: '/tmp', lastMessageAt: new Date().toISOString() },
      ]
    })
    runCommand.mockResolvedValue({
      stdout: '{"sessionId":"fresh-session","text":"ok"}',
      stderr: '',
      code: 0,
    })
    agentRow = {
      id: 11,
      name: 'backend',
      framework: 'codex',
      session_key: 'shared-session',
      config: JSON.stringify({ session_mode: 'dedicated', session_state: 'ready', mc_bound_agent_id: 11 }),
      workspace_path: '/tmp',
      source: 'user',
      parent_id: 4,
      status: 'idle',
    }

    const { executeBoundLocalAgentPrompt } = await import('@/lib/local-session-executor')
    const result = await executeBoundLocalAgentPrompt(agentRow, 'hello')

    expect(result.sessionId).toBe('fresh-session')
    expect(agentRow.session_key).toBe('fresh-session')
    expect(
      runCommand.mock.calls.some(
        (call) =>
          Array.isArray(call[1])
          && call[1].includes('exec')
          && call[1].some((arg: unknown) => String(arg || '').includes('Now respond to the following user message')),
      ),
    ).toBe(true)
  })

  it('treats codex start as success when stderr has rollout noise but stdout has thread id', async () => {
    const threadId = '019e39e8-5d7e-74d2-b6a4-a02f43bd6229'
    scanCodexSessions.mockReturnValue([])
    runCommand.mockRejectedValueOnce({
      stdout: `{"type":"thread.started","thread_id":"${threadId}"}\n{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"hello back"}}`,
      stderr: 'failed to record rollout items: thread not found\n',
      message: 'Command failed',
    })
    agentRow = {
      id: 13,
      name: '测试3',
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

    expect(result.sessionId).toBe(threadId)
    expect(runUpdate).toHaveBeenLastCalledWith(
      threadId,
      expect.stringContaining('"primary_session_key":"' + threadId + '"'),
      'idle',
      expect.any(Number),
      13,
    )
  })

  it('does not pick codex sessions reserved by other agents when auto provisioning', async () => {
    otherAgentsSessionKeys = [{ session_key: 'taken-session' }]
    let scanPass = 0
    scanCodexSessions.mockImplementation(() => {
      scanPass += 1
      if (scanPass === 1) {
        return [{
          sessionId: 'old-session',
          projectPath: '/tmp',
          firstMessageAt: new Date(Date.now() - 60000).toISOString(),
          lastMessageAt: new Date(Date.now() - 60000).toISOString(),
        }]
      }
      return [
        {
          sessionId: 'taken-session',
          projectPath: '/tmp',
          firstMessageAt: new Date().toISOString(),
          lastMessageAt: new Date().toISOString(),
        },
        {
          sessionId: 'free-session',
          projectPath: '/tmp',
          firstMessageAt: new Date().toISOString(),
          lastMessageAt: new Date().toISOString(),
        },
      ]
    })
    runCommand.mockResolvedValue({
      stdout: '{"type":"thread.started","thread_id":"free-session"}\n{"type":"item.completed","item":{"text":"codex-new-reply"}}',
      stderr: '',
      code: 0,
    })
    agentRow = {
      id: 12,
      name: 'worker',
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

    expect(result.sessionId).toBe('free-session')
    expect(runUpdate).toHaveBeenLastCalledWith(
      'free-session',
      expect.stringContaining('"mc_bound_agent_id":12'),
      'idle',
      expect.any(Number),
      12,
    )
  })

  it('enqueueBoundLocalAgentPrompt returns immediately while CLI runs in background', async () => {
    agentRow = {
      id: 1,
      name: 'codex-agent',
      framework: 'codex',
      session_key: 'sess-immediate',
      config: JSON.stringify({ session_mode: 'dedicated', session_state: 'ready' }),
      workspace_path: '/tmp',
    }

    let resolveDeferred!: (value: { stdout: string; stderr: string }) => void
    const pending = new Promise<{ stdout: string; stderr: string }>((resolve) => {
      resolveDeferred = resolve
    })
    runCommand.mockReturnValue(pending)

    const { enqueueBoundLocalAgentPrompt } = await import('@/lib/local-session-executor')
    const started = Date.now()
    const result = enqueueBoundLocalAgentPrompt(agentRow, 'hello')
    expect(Date.now() - started).toBeLessThan(100)
    expect(result).toEqual({
      accepted: true,
      sessionKey: 'sess-immediate',
      kind: 'codex-cli',
    })

    resolveDeferred({
      stdout: JSON.stringify({ type: 'thread.started', thread_id: 'sess-immediate' }),
      stderr: '',
    })
    await new Promise((resolve) => setImmediate(resolve))
  })
})
