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
  return { get: vi.fn(() => null) }
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
})
