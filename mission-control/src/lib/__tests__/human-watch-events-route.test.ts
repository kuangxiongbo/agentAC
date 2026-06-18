import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'
import { createPermissionRequest } from '@/lib/permission-requests'

const requireRole = vi.fn()
const mutationLimiter = vi.fn(() => null)
const requestBridgeClientSessionContinue = vi.fn()
const notifySessionTranscriptUpdated = vi.fn()
const enqueueLocalSessionPrompt = vi.fn()
const isLocalSessionKind = vi.fn((kind: string) =>
  ['claude-code', 'codex-cli', 'hermes', 'cursor', 'opencode'].includes(kind),
)

vi.mock('@/lib/auth', () => ({
  requireRole,
}))

vi.mock('@/lib/rate-limit', () => ({
  mutationLimiter,
}))

vi.mock('@/lib/bridge-server', () => ({
  requestBridgeClientSessionContinue,
}))

vi.mock('@/lib/session-realtime', () => ({
  notifySessionTranscriptUpdated,
}))

vi.mock('@/lib/local-session-executor', () => ({
  enqueueLocalSessionPrompt,
  isLocalSessionKind,
}))

describe('human-watch events routes', () => {
  let db: Database.Database

  beforeEach(async () => {
    vi.resetModules()
    db = new Database(':memory:')
    runMigrations(db)
    requireRole.mockReturnValue({ user: { id: 2, workspace_id: 1, tenant_id: 1, role: 'operator' } })
    mutationLimiter.mockReturnValue(null)

    vi.doMock('@/lib/db', () => ({
      getDatabase: () => db,
    }))
  })

  afterEach(() => {
    db.close()
    vi.clearAllMocks()
  })

  it('lists pending events and marks them visible', async () => {
    const { createHumanWatchEvent } = await import('@/lib/human-watch-events')
    createHumanWatchEvent(
      {
        workspaceId: 1,
        tenantId: 1,
        clientId: 'edge-a',
        workerLocalAgentId: 5,
        workerName: 'worker-a',
        workerSessionId: 'sess-a',
        source: 'worker_tool',
        title: '等待值守',
        summary: 'worker 等待介入',
      },
      db,
    )

    const { GET } = await import('@/app/api/human-watch/events/route')
    const request = new NextRequest('http://localhost/api/human-watch/events?client_id=edge-a&status=pending')
    const response = await GET(request)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.count).toBe(1)
    expect(body.events[0].status).toBe('visible')
  })

  it('handles send_message_to_worker action and resolves the event', async () => {
    const { createHumanWatchEvent } = await import('@/lib/human-watch-events')
    const event = createHumanWatchEvent(
      {
        workspaceId: 1,
        tenantId: 1,
        clientId: 'edge-a',
        workerLocalAgentId: 5,
        workerName: 'worker-a',
        workerSessionId: 'sess-a',
        source: 'transcript_wait',
        title: '等待值守',
        summary: 'worker 等待回复',
        context: { session_kind: 'codex-cli' },
      },
      db,
    )

    requestBridgeClientSessionContinue.mockResolvedValue({
      accepted: true,
      sessionId: 'sess-a',
      reply: 'ok',
    })

    const { POST } = await import('@/app/api/human-watch/events/[id]/action/route')
    const request = new NextRequest(`http://localhost/api/human-watch/events/${event.id}/action`, {
      method: 'POST',
      body: JSON.stringify({
        action: 'send_message_to_worker',
        message: '请继续执行',
      }),
      headers: { 'content-type': 'application/json' },
    })

    const response = await POST(request, { params: Promise.resolve({ id: event.id }) })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(requestBridgeClientSessionContinue).toHaveBeenCalled()
    expect(notifySessionTranscriptUpdated).toHaveBeenCalledWith('codex-cli', 'sess-a', 'human_watch_action')
    expect(body.event.status).toBe('resolved')
    expect(body.event.resolved_action).toBe('send_message_to_worker')
  })

  it('falls back to local session enqueue when worker session is offline but session kind is local', async () => {
    const { createHumanWatchEvent, getHumanWatchEvent } = await import('@/lib/human-watch-events')
    const event = createHumanWatchEvent(
      {
        workspaceId: 1,
        tenantId: 1,
        clientId: 'edge-a',
        workerLocalAgentId: 5,
        workerName: 'worker-a',
        workerSessionId: 'sess-offline',
        source: 'transcript_wait',
        title: '等待值守',
        summary: 'worker 等待回复',
        context: { session_kind: 'codex-cli' },
      },
      db,
    )

    requestBridgeClientSessionContinue.mockRejectedValue(new Error('socket unavailable'))
    enqueueLocalSessionPrompt.mockReturnValue({
      accepted: true,
      sessionKey: 'sess-offline',
      kind: 'codex-cli',
    })

    const { POST } = await import('@/app/api/human-watch/events/[id]/action/route')
    const request = new NextRequest(`http://localhost/api/human-watch/events/${event.id}/action`, {
      method: 'POST',
      body: JSON.stringify({
        action: 'send_message_to_worker',
        message: '请继续执行',
      }),
      headers: { 'content-type': 'application/json' },
    })

    const response = await POST(request, { params: Promise.resolve({ id: event.id }) })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(enqueueLocalSessionPrompt).toHaveBeenCalledWith('codex-cli', 'sess-offline', '请继续执行')
    expect(getHumanWatchEvent(event.id, 1, db)?.status).toBe('resolved')
    expect(body.event.resolved_action).toBe('send_message_to_worker')
  })

  it('returns a clear error when worker session is offline and no local fallback is possible', async () => {
    const { createHumanWatchEvent, getHumanWatchEvent } = await import('@/lib/human-watch-events')
    const event = createHumanWatchEvent(
      {
        workspaceId: 1,
        tenantId: 1,
        clientId: 'edge-a',
        workerLocalAgentId: 5,
        workerName: 'worker-a',
        workerSessionId: 'sess-invalid',
        source: 'transcript_wait',
        title: '等待值守',
        summary: 'worker 等待回复',
        context: { session_kind: 'unknown-kind' },
      },
      db,
    )

    requestBridgeClientSessionContinue.mockRejectedValue(new Error('socket unavailable'))

    const { POST } = await import('@/app/api/human-watch/events/[id]/action/route')
    const request = new NextRequest(`http://localhost/api/human-watch/events/${event.id}/action`, {
      method: 'POST',
      body: JSON.stringify({
        action: 'send_message_to_worker',
        message: '请继续执行',
      }),
      headers: { 'content-type': 'application/json' },
    })

    const response = await POST(request, { params: Promise.resolve({ id: event.id }) })
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(String(body.error)).toContain('Event missing valid session_kind')
    expect(getHumanWatchEvent(event.id, 1, db)?.status).toBe('pending')
  })

  it('handles approve_request action and resolves both event and permission request', async () => {
    const { createHumanWatchEvent } = await import('@/lib/human-watch-events')
    createPermissionRequest(
      {
        id: 'route-pr-1',
        workspaceId: 1,
        tenantId: 1,
        clientId: 'edge-a',
        workerLocalAgentId: 5,
        workerName: 'worker-a',
        workerSessionId: 'sess-a',
        requestType: 'local_cli_permission',
        title: '等待确认',
        prompt: 'worker 请求审批',
        options: [
          { id: 'approve_once', label: '批准', action: 'approve' },
          { id: 'deny', label: '拒绝', action: 'deny' },
        ],
      },
      db,
    )
    const event = createHumanWatchEvent(
      {
        workspaceId: 1,
        tenantId: 1,
        clientId: 'edge-a',
        workerLocalAgentId: 5,
        workerName: 'worker-a',
        workerSessionId: 'sess-a',
        source: 'permission_request',
        title: '等待审批',
        summary: 'permission request',
        permissionRequestId: 'route-pr-1',
        context: { session_kind: 'codex-cli' },
      },
      db,
    )

    const { POST } = await import('@/app/api/human-watch/events/[id]/action/route')
    const request = new NextRequest(`http://localhost/api/human-watch/events/${event.id}/action`, {
      method: 'POST',
      body: JSON.stringify({
        action: 'approve_request',
        note: '人工值守批准',
      }),
      headers: { 'content-type': 'application/json' },
    })

    const response = await POST(request, { params: Promise.resolve({ id: event.id }) })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.event.status).toBe('resolved')
    expect(body.event.resolved_action).toBe('approve_request')
    expect(body.request.status).toBe('approved')
  })

  it('handles dismiss action', async () => {
    const { createHumanWatchEvent } = await import('@/lib/human-watch-events')
    const event = createHumanWatchEvent(
      {
        workspaceId: 1,
        tenantId: 1,
        clientId: 'edge-a',
        workerLocalAgentId: 5,
        workerName: 'worker-a',
        workerSessionId: 'sess-a',
        source: 'transcript_wait',
        title: '等待值守',
        summary: 'worker 等待回复',
      },
      db,
    )

    const { POST } = await import('@/app/api/human-watch/events/[id]/action/route')
    const request = new NextRequest(`http://localhost/api/human-watch/events/${event.id}/action`, {
      method: 'POST',
      body: JSON.stringify({
        action: 'dismiss',
        note: '忽略本次事件',
      }),
      headers: { 'content-type': 'application/json' },
    })

    const response = await POST(request, { params: Promise.resolve({ id: event.id }) })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.event.status).toBe('dismissed')
    expect(body.event.resolved_action).toBe('dismiss')
  })

  it('falls back to local session enqueue when bridge is offline but session kind is local', async () => {
    const { createHumanWatchEvent, getHumanWatchEvent } = await import('@/lib/human-watch-events')
    const event = createHumanWatchEvent(
      {
        workspaceId: 1,
        tenantId: 1,
        clientId: 'edge-a',
        workerLocalAgentId: 5,
        workerName: 'worker-a',
        workerSessionId: 'sess-local',
        source: 'transcript_wait',
        title: '等待值守',
        summary: 'worker 等待回复',
        context: { session_kind: 'codex-cli' },
      },
      db,
    )

    requestBridgeClientSessionContinue.mockRejectedValue(new Error('socket unavailable'))
    enqueueLocalSessionPrompt.mockReturnValue({
      accepted: true,
      sessionKey: 'sess-local',
      kind: 'codex-cli',
    })

    const { POST } = await import('@/app/api/human-watch/events/[id]/action/route')
    const request = new NextRequest(`http://localhost/api/human-watch/events/${event.id}/action`, {
      method: 'POST',
      body: JSON.stringify({
        action: 'send_message_to_worker',
        message: '请继续执行',
      }),
      headers: { 'content-type': 'application/json' },
    })

    const response = await POST(request, { params: Promise.resolve({ id: event.id }) })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(enqueueLocalSessionPrompt).toHaveBeenCalledWith('codex-cli', 'sess-local', '请继续执行')
    expect(getHumanWatchEvent(event.id, 1, db)?.status).toBe('resolved')
    expect(body.event.resolved_action).toBe('send_message_to_worker')
  })
})
