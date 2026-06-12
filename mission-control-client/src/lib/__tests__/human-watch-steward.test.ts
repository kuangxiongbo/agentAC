import { beforeEach, describe, expect, it, vi } from 'vitest'

let lastInsertId = 1
let storedAgent: Record<string, unknown> | null = null

const runInsert = vi.fn((...args: unknown[]) => {
  const configJson = typeof args[7] === 'string' ? args[7] : JSON.stringify({ agent_kind: 'human_watch' })
  storedAgent = {
    id: lastInsertId,
    name: 'Steward A',
    role: 'human-watch',
    session_key: null,
    soul_content: 'soul',
    status: 'idle',
    framework: 'codex',
    workspace_path: null,
    workspace_id: 1,
    config: configJson,
    created_at: 1,
    updated_at: 1,
  }
  return { lastInsertRowid: lastInsertId }
})

const prepare = vi.fn((sql: string) => {
  if (sql.includes('INSERT INTO agents')) {
    return { run: runInsert }
  }
  if (sql.includes('SELECT * FROM agents WHERE id = ?')) {
    return {
      get: vi.fn(() => storedAgent),
    }
  }
  return { run: vi.fn(), get: vi.fn() }
})

const getDatabase = vi.fn(() => ({ prepare }))

vi.mock('@/lib/db', () => ({
  getDatabase,
  db_helpers: { logActivity: vi.fn() },
}))

vi.mock('@/lib/event-bus', () => ({
  eventBus: { broadcast: vi.fn() },
}))

vi.mock('@/lib/local-session-executor', () => ({
  shouldAutoProvisionSessionOnCreate: vi.fn(() => true),
  enqueueProvisionAgentDedicatedSession: vi.fn(),
  releaseAgentExecutionQueues: vi.fn(),
}))

describe('human-watch-steward', () => {
  beforeEach(() => {
    vi.resetModules()
    lastInsertId = 1
    storedAgent = null
    runInsert.mockClear()
    prepare.mockClear()
    getDatabase.mockClear()
  })

  it('rejects creation without authorization', async () => {
    const { createHumanWatchStewardAgent } = await import('@/lib/human-watch-steward')
    expect(() =>
      createHumanWatchStewardAgent({
        name: 'Steward A',
        framework: 'claude-code',
        authorized: false,
      }),
    ).toThrow(/not authorized/)
  })

  it('creates steward agent with human_watch config', async () => {
    const { createHumanWatchStewardAgent, HUMAN_WATCH_AGENT_KIND, HUMAN_WATCH_AGENT_ROLE } =
      await import('@/lib/human-watch-steward')
    const { enqueueProvisionAgentDedicatedSession } = await import('@/lib/local-session-executor')
    const { agent, sessionProvisioning } = createHumanWatchStewardAgent({
      name: 'Steward A',
      framework: 'codex-cli',
      authorized: true,
    })

    expect(agent.role).toBe(HUMAN_WATCH_AGENT_ROLE)
    expect(agent.config.agent_kind).toBe(HUMAN_WATCH_AGENT_KIND)
    expect((agent.config as { steward?: { llm_enabled?: boolean } }).steward?.llm_enabled).toBe(true)
    expect(agent.framework).toBe('codex')
    expect(sessionProvisioning).toBe(true)
    expect(runInsert).toHaveBeenCalled()
    expect(enqueueProvisionAgentDedicatedSession).toHaveBeenCalled()
  })
})
