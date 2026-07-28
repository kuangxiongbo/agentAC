import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'
import {
  createHumanWatchEvent,
  getHumanWatchEvent,
  hasActiveHumanWatchEventDedupeKey,
  listHumanWatchEvents,
  updateHumanWatchEvent,
} from '@/lib/human-watch-events'
import { createPermissionRequest } from '@/lib/permission-requests'

describe('human-watch-events', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
  })

  afterEach(() => {
    db.close()
  })

  it('creates a pending watch event with created audit', () => {
    const created = createHumanWatchEvent(
      {
        workspaceId: 1,
        tenantId: 1,
        clientId: 'edge-a',
        workerLocalAgentId: 5,
        workerName: 'worker-a',
        workerSessionId: 'sess-1',
        source: 'worker_tool',
        title: '等待值守',
        summary: 'worker 等待确认',
        context: { session_kind: 'codex-cli' },
        latestWorkerMessage: 'Please confirm',
        suggestedAction: 'send_message_to_worker',
        dedupeKey: 'watch:sess-1',
      },
      db,
    )

    expect(created.status).toBe('pending')
    expect(created.context?.event_audit).toBeTruthy()
    expect(
      Array.isArray(created.context?.event_audit)
        ? (created.context?.event_audit as Array<{ event_name?: string }>).map((item) => item.event_name)
        : [],
    ).toContain('watch_event_created')
  })

  it('dedupes active events by dedupe key', () => {
    const first = createHumanWatchEvent(
      {
        workspaceId: 1,
        clientId: 'edge-a',
        source: 'transcript_rule',
        title: '等待值守',
        summary: 'worker 等待回复',
        dedupeKey: 'dup-1',
      },
      db,
    )
    const second = createHumanWatchEvent(
      {
        workspaceId: 1,
        clientId: 'edge-a',
        source: 'transcript_rule',
        title: '等待值守',
        summary: 'worker 等待回复',
        dedupeKey: 'dup-1',
      },
      db,
    )

    expect(second.id).toBe(first.id)
    expect(listHumanWatchEvents({ workspaceId: 1 }, db)).toHaveLength(1)
    expect(hasActiveHumanWatchEventDedupeKey(1, 'edge-a', 'dup-1', db)).toBe(true)
    expect(hasActiveHumanWatchEventDedupeKey(1, 'edge-a', 'missing', db)).toBe(false)
  })

  it('records claim and resolve audit trail in context', () => {
    createPermissionRequest(
      {
        id: 'pr-1',
        workspaceId: 1,
        clientId: 'edge-a',
        requestType: 'local_cli_permission',
        title: '等待审批',
        prompt: 'worker 请求审批',
        options: [
          { id: 'approve', label: 'Approve', action: 'approve' },
          { id: 'deny', label: 'Deny', action: 'deny' },
        ],
      },
      db,
    )

    const created = createHumanWatchEvent(
      {
        workspaceId: 1,
        clientId: 'edge-a',
        source: 'permission_request',
        title: '等待审批',
        summary: 'worker 请求审批',
        permissionRequestId: 'pr-1',
      },
      db,
    )

    const claimed = updateHumanWatchEvent(
      created.id,
      1,
      {
        status: 'claimed',
        claimedByType: 'human_user',
        claimedByUserId: 7,
      },
      db,
    )
    expect(claimed?.status).toBe('claimed')

    const resolved = updateHumanWatchEvent(
      created.id,
      1,
      {
        status: 'resolved',
        resolvedAction: 'approve_request',
        resolvedByType: 'human_user',
        resolvedByUserId: 7,
      },
      db,
    )
    expect(resolved?.status).toBe('resolved')

    const fetched = getHumanWatchEvent(created.id, 1, db)
    const audit = Array.isArray(fetched?.context?.event_audit)
      ? fetched?.context?.event_audit as Array<{ event_name?: string }>
      : []
    expect(audit.map((item) => item.event_name)).toContain('watch_event_claimed')
    expect(audit.map((item) => item.event_name)).toContain('watch_event_closed')
  })

  it('stores structured context for permission request watch events', () => {
    createPermissionRequest(
      {
        id: 'pr-ctx-1',
        workspaceId: 1,
        clientId: 'edge-a',
        requestType: 'local_cli_permission',
        title: '等待审批',
        prompt: '是否允许继续执行 rm -rf target-cache',
        risk: 'high',
        options: [
          { id: 'approve', label: 'Approve', action: 'approve' },
          { id: 'deny', label: 'Deny', action: 'deny' },
        ],
      },
      db,
    )

    const event = listHumanWatchEvents({ workspaceId: 1 }, db).find((row) => row.permission_request_id === 'pr-ctx-1')
    expect(event).toBeDefined()
    expect(event?.context?.event_kind).toBe('permission_request')
    expect(String(event?.context?.worker_judge_context || '')).toContain('请求标题')
    expect(String(event?.context?.worker_summary || '')).toContain('等待审批')
  })
})
