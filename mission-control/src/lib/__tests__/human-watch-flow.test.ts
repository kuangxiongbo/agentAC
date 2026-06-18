import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'
import { createPermissionRequest, getPermissionRequest } from '@/lib/permission-requests'
import { listHumanWatchEvents, updateHumanWatchEvent } from '@/lib/human-watch-events'

describe('human-watch flow', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
  })

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })

  it('creates a pending watch event when a permission request is created, then resolves it after approval', () => {
    const request = createPermissionRequest(
      {
        id: 'flow-pr-1',
        workspaceId: 1,
        tenantId: 1,
        clientId: 'edge-a',
        workerLocalAgentId: 5,
        workerName: 'worker-a',
        workerSessionId: 'sess-a',
        stewardLocalAgentId: 9,
        stewardName: 'steward-a',
        requestType: 'local_cli_permission',
        title: '需要确认',
        prompt: 'Worker 正在等待是否继续执行。',
        risk: 'medium',
        options: [
          { id: 'approve_once', label: '批准', action: 'approve' },
          { id: 'deny', label: '拒绝', action: 'deny' },
        ],
        context: {
          watch_event: {
            source: 'worker_tool',
          },
        },
      },
      db,
    )

    const events = listHumanWatchEvents({ workspaceId: 1, permissionRequestId: request.id }, db)
    expect(events).toHaveLength(1)
    expect(events[0]?.status).toBe('pending')

    const resolved = updateHumanWatchEvent(
      events[0]!.id,
      1,
      {
        status: 'resolved',
        resolvedAction: 'approve_request',
        resolvedByType: 'human_user',
        resolvedByUserId: 2,
        resolvedNote: '人工值守已确认',
      },
      db,
    )

    expect(resolved?.status).toBe('resolved')
    const latest = listHumanWatchEvents({ workspaceId: 1, permissionRequestId: request.id }, db)[0]
    expect(latest?.resolved_action).toBe('approve_request')
    expect(Array.isArray(latest?.context?.event_audit)).toBe(true)
  })

  it('marks linked events resolved when permission request is decided', () => {
    createPermissionRequest(
      {
        id: 'flow-pr-2',
        workspaceId: 1,
        tenantId: 1,
        clientId: 'edge-a',
        workerLocalAgentId: 5,
        workerName: 'worker-a',
        workerSessionId: 'sess-a',
        requestType: 'local_cli_permission',
        title: '等待确认',
        prompt: 'Worker 请求写入配置文件。',
        risk: 'medium',
        options: [
          { id: 'approve_once', label: '批准', action: 'approve' },
          { id: 'deny', label: '拒绝', action: 'deny' },
        ],
      },
      db,
    )

    const request = getPermissionRequest('flow-pr-2', 1, db)
    expect(request?.status).toBe('pending')

    const event = listHumanWatchEvents({ workspaceId: 1, permissionRequestId: 'flow-pr-2' }, db)[0]
    expect(event?.status).toBe('pending')
  })
})
