import { beforeEach, describe, expect, it, vi } from 'vitest'

const upsertPermissionRequestSnapshot = vi.fn()
const getPermissionRequest = vi.fn()
const isDangerousPermissionRequest = vi.fn()
const runStewardJudgeOnEdge = vi.fn()

const safeSendCalls: any[] = []
class MockWebSocket {
  readyState = 1
  send(payload: string) {
    safeSendCalls.push(JSON.parse(payload))
  }
}

const dbPrepare = vi.fn((sql: string) => {
  if (sql.includes('SELECT * FROM agents WHERE id = ?')) {
    return {
      get: vi.fn(() => ({
        id: 45,
        role: 'human-watch',
        config: {
          steward: {
            permission_judge_prompt_template:
              'PERMISSION PROMPT\n标题:{title}\n风险:{risk}\n选项:\n{options}\n上下文:\n{context}',
          },
        },
      })),
    }
  }
  if (sql.includes('FROM tasks t') && sql.includes('LEFT JOIN projects')) {
    return {
      all: vi.fn(() => [{
        id: 7,
        title: 'Local task',
        description: 'Run locally',
        status: 'in_progress',
        priority: 'high',
        assigned_to: 'Worker',
        created_by: 'local',
        created_at: 10,
        updated_at: 20,
        tags: '["edge"]',
        metadata: '{"source":"local"}',
      }]),
    }
  }
  if (sql.includes('SELECT status, COUNT(*) AS count') && sql.includes('FROM tasks')) {
    return { all: vi.fn(() => [{ status: 'in_progress', count: 1 }]) }
  }
  if (sql.includes('FROM activities') && sql.includes('COUNT(*)')) {
    return { get: vi.fn(() => ({ total: 1 })) }
  }
  if (sql.includes('FROM activities')) {
    return { all: vi.fn(() => [{
      id: 9,
      type: 'task_updated',
      entity_type: 'task',
      entity_id: 7,
      actor: 'Worker',
      description: 'Local task moved to in progress',
      data: '{"status":"in_progress"}',
      created_at: 20,
    }]) }
  }
  return { get: vi.fn(() => null), all: vi.fn(() => []) }
})

vi.mock('@/lib/db', () => ({
  getDatabase: vi.fn(() => ({ prepare: dbPrepare })),
  db_helpers: {},
}))

vi.mock('@/lib/event-bus', () => ({
  eventBus: { broadcast: vi.fn(), on: vi.fn(), off: vi.fn() },
}))

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('@/lib/config', () => ({
  REMOTE_SERVER_URL: 'ws://127.0.0.1:5000',
  REMOTE_SERVER_TOKEN: '',
  REMOTE_RECONNECT_MS: 1000,
  config: {
    memoryDir: '',
    memoryAllowedPrefixes: [],
  },
}))

vi.mock('@/lib/local-session-executor', () => ({
  enqueueLocalSessionPrompt: vi.fn(),
  isLocalSessionKind: vi.fn(() => true),
}))

vi.mock('@/lib/session-transcript', () => ({
  readLocalSessionTranscriptPage: vi.fn(),
}))

vi.mock('@/lib/session-realtime', () => ({
  notifySessionTranscriptUpdated: vi.fn(),
}))

vi.mock('@/lib/session-sync', () => ({
  getSyncableSessions: vi.fn(async () => [{
    session_id: 'session-a',
    session_key: 'worker-a',
    session_kind: 'codex-cli',
    runtime_group: 'codex',
    agent: 'Worker',
    model: 'gpt-5',
    active: true,
    last_activity: 21_000,
    working_dir: '/tmp/project',
    last_user_prompt: null,
  }]),
}))

vi.mock('@/lib/agents-by-session', () => ({
  findAgentsBoundToSession: vi.fn(() => []),
}))

vi.mock('@/lib/agent-session-binding', () => ({
  validateAgentSessionKindBinding: vi.fn(() => ({ ok: true })),
  isBindableSessionKind: vi.fn(() => true),
}))

vi.mock('@/lib/infer-local-session-kind', () => ({
  resolveSessionKindForBinding: vi.fn(() => 'codex-cli'),
}))

vi.mock('@/lib/human-watch-steward', () => ({
  createHumanWatchStewardAgent: vi.fn(),
  deleteHumanWatchStewardAgent: vi.fn(),
  updateHumanWatchStewardAgent: vi.fn(),
}))

vi.mock('@/lib/human-watch-judge', () => ({
  runStewardJudgeOnEdge,
}))

vi.mock('@/lib/deliver-agent-message', () => ({
  deliverAgentMessage: vi.fn(),
}))

vi.mock('@/lib/edge-upstream-fetch', () => ({
  edgeUpstreamFetch: vi.fn(),
  isEdgeTlsInsecure: vi.fn(() => false),
}))

vi.mock('@/lib/permission-requests', () => ({
  getPermissionRequest,
  listPermissionRequests: vi.fn(() => []),
  isDangerousPermissionRequest,
  upsertPermissionRequestSnapshot,
}))

vi.mock('@/lib/security-events', () => ({
  logSecurityEvent: vi.fn(),
}))

vi.mock('@/lib/local-cli-elevation-audit', () => ({
  validateLocalCliElevationGrant: vi.fn(() => ({ ok: true })),
}))

function buildRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pr-1',
    workspace_id: 1,
    tenant_id: 1,
    client_id: 'edge-a',
    binding_id: 1,
    worker_sync_index_id: null,
    worker_local_agent_id: 21,
    worker_name: 'worker-a',
    worker_session_id: 'sess-a',
    steward_sync_index_id: null,
    steward_local_agent_id: 45,
    steward_name: 'steward-a',
    request_type: 'local_cli_permission',
    title: '允许继续分析',
    prompt: 'Worker requests a reversible analysis step.',
    risk: 'medium',
    status: 'pending',
    options: [
      { id: 'approve', label: 'Approve', action: 'approve' },
      { id: 'deny', label: 'Deny', action: 'deny' },
      { id: 'ask_human', label: 'Ask human', action: 'ask_human' },
    ],
    context: { worker_judge_context: '- 请求标题: 允许继续分析' },
    selected_option_id: null,
    decision_reason: null,
    decider_type: null,
    decider_user_id: null,
    decider_agent_id: null,
    decided_at: null,
    expires_at: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  }
}

describe('remote-server-bridge permission steward auto decision', () => {
  beforeEach(() => {
    vi.resetModules()
    safeSendCalls.length = 0
    dbPrepare.mockClear()
    upsertPermissionRequestSnapshot.mockReset()
    getPermissionRequest.mockReset()
    isDangerousPermissionRequest.mockReset()
    runStewardJudgeOnEdge.mockReset()
  })

  it('auto-approves safe pending permission requests through steward judge', async () => {
    const request = buildRequest()
    getPermissionRequest.mockReturnValue(request)
    isDangerousPermissionRequest.mockReturnValue(false)
    runStewardJudgeOnEdge.mockResolvedValue({
      reply: JSON.stringify({ decision: 'approve', option_id: 'approve', reason: 'safe_reversible_step' }),
      sessionId: 'judge-1',
    })

    const mod = await import('@/lib/remote-server-bridge')
    ;(mod as any).__testSetBridgeSocket?.(new MockWebSocket())
    ;(mod as any).__testSyncPermissionRequestSnapshot?.(request)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(upsertPermissionRequestSnapshot).toHaveBeenCalled()
    expect(runStewardJudgeOnEdge).toHaveBeenCalled()
    expect(String(runStewardJudgeOnEdge.mock.calls[0]?.[1] || '')).toContain('PERMISSION PROMPT')
    expect(safeSendCalls.some((msg) => msg.type === 'permission_decision_sync' && msg.optionId === 'approve')).toBe(true)
  })

  it('does not auto-approve dangerous permission requests', async () => {
    const request = buildRequest({ title: '删除目录' })
    getPermissionRequest.mockReturnValue(request)
    isDangerousPermissionRequest.mockReturnValue(true)

    const mod = await import('@/lib/remote-server-bridge')
    ;(mod as any).__testSetBridgeSocket?.(new MockWebSocket())
    ;(mod as any).__testSyncPermissionRequestSnapshot?.(request)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(runStewardJudgeOnEdge).not.toHaveBeenCalled()
    expect(safeSendCalls.some((msg) => msg.type === 'permission_decision_sync')).toBe(false)
  })

  it('ignores invalid steward judge replies', async () => {
    const request = buildRequest()
    getPermissionRequest.mockReturnValue(request)
    isDangerousPermissionRequest.mockReturnValue(false)
    runStewardJudgeOnEdge.mockResolvedValue({
      reply: '继续吧',
      sessionId: 'judge-1',
    })

    const mod = await import('@/lib/remote-server-bridge')
    ;(mod as any).__testSetBridgeSocket?.(new MockWebSocket())
    ;(mod as any).__testSyncPermissionRequestSnapshot?.(request)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(runStewardJudgeOnEdge).toHaveBeenCalled()
    expect(safeSendCalls.some((msg) => msg.type === 'permission_decision_sync')).toBe(false)
  })

  it('returns a parsed local task snapshot over the bridge protocol', async () => {
    const mod = await import('@/lib/remote-server-bridge')
    ;(mod as any).__testSetBridgeSocket?.(new MockWebSocket())
    ;(mod as any).__testHandleBridgeMessage?.(JSON.stringify({
      type: 'task_snapshot_request',
      requestId: 'snapshot-1',
      limit: 50,
    }))

    expect(safeSendCalls).toContainEqual(expect.objectContaining({
      type: 'task_snapshot_response',
      requestId: 'snapshot-1',
      ok: true,
      total: 1,
      byStatus: { in_progress: 1 },
      truncated: false,
      tasks: [expect.objectContaining({
        id: 7,
        tags: ['edge'],
        metadata: { source: 'local' },
      })],
    }))
  })

  it('returns local activity and session milestones over the bridge protocol', async () => {
    const mod = await import('@/lib/remote-server-bridge')
    ;(mod as any).__testSetBridgeSocket?.(new MockWebSocket())
    ;(mod as any).__testHandleBridgeMessage?.(JSON.stringify({
      type: 'activity_snapshot_request',
      requestId: 'activity-snapshot-1',
      limit: 50,
    }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(safeSendCalls).toContainEqual(expect.objectContaining({
      type: 'activity_snapshot_response',
      requestId: 'activity-snapshot-1',
      ok: true,
      total: 2,
      truncated: false,
      activities: expect.arrayContaining([
        expect.objectContaining({ id: 9, type: 'task_updated', data: { status: 'in_progress' } }),
        expect.objectContaining({ type: 'session_activity', actor: 'Worker' }),
      ]),
    }))
  })
})
