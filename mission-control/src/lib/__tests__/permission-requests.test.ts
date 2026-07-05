import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'
import {
  createPermissionRequest,
  decidePermissionRequest,
  getPermissionRequest,
  listPermissionRequests,
  patchPermissionRequestContext,
  recordWorkerHumanReply,
  waitForPermissionRequestDecision,
} from '@/lib/permission-requests'
import { listHumanWatchEvents } from '@/lib/human-watch-events'

describe('permission-requests', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
  })

  afterEach(() => {
    db.close()
  })

  function createBase(id = 'pr-1') {
    return createPermissionRequest(
      {
        id,
        workspaceId: 1,
        tenantId: 1,
        clientId: 'mac-1',
        workerLocalAgentId: 5,
        stewardLocalAgentId: 9,
        requestType: 'local_cli_permission',
        title: '需要选择权限',
        prompt: 'Worker 请求读取项目目录。',
        risk: 'medium',
        options: [
          { id: 'approve_readonly', label: '允许只读', action: 'approve' },
          { id: 'deny', label: '拒绝', action: 'deny' },
        ],
        context: { cwd: '/tmp/project' },
      },
      db,
    )
  }

  it('creates and lists pending permission requests', () => {
    const created = createBase()
    expect(created.status).toBe('pending')
    expect(created.options).toHaveLength(2)
    expect(created.context?.cwd).toBe('/tmp/project')

    const rows = listPermissionRequests({ workspaceId: 1, tenantId: 1, status: 'pending' }, db)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe('pr-1')

    const events = listHumanWatchEvents({ workspaceId: 1, permissionRequestId: 'pr-1' }, db)
    expect(events).toHaveLength(1)
    expect(events[0]?.status).toBe('pending')
    expect(events[0]?.source).toBe('permission_request')
    expect(events[0]?.permission_request_id).toBe('pr-1')
  })

  it('decides by option id and records the decider', () => {
    createBase()
    const decided = decidePermissionRequest(
      {
        requestId: 'pr-1',
        workspaceId: 1,
        optionId: 'approve_readonly',
        reason: 'low scope',
        deciderType: 'steward_agent',
        deciderAgentId: 'steward-9',
      },
      db,
    )

    expect(decided.status).toBe('approved')
    expect(decided.selected_option_id).toBe('approve_readonly')
    expect(decided.decider_type).toBe('steward_agent')
    expect(decided.decider_agent_id).toBe('steward-9')

    const decision = db
      .prepare(`SELECT * FROM permission_request_decisions WHERE request_id = ?`)
      .get('pr-1') as { option_id?: string } | undefined
    expect(decision?.option_id).toBe('approve_readonly')

    const events = listHumanWatchEvents({ workspaceId: 1, permissionRequestId: 'pr-1' }, db)
    expect(events).toHaveLength(1)
    expect(events[0]?.status).toBe('resolved')
    expect(events[0]?.resolved_action).toBe('approve_request')
  })

  it('rejects invalid option ids', () => {
    createBase()
    expect(() =>
      decidePermissionRequest(
        {
          requestId: 'pr-1',
          workspaceId: 1,
          optionId: 'missing',
          deciderType: 'human_user',
        },
        db,
      ),
    ).toThrow('Invalid optionId')
  })

  it('rejects duplicate decisions after status changed', () => {
    createBase()
    decidePermissionRequest(
      {
        requestId: 'pr-1',
        workspaceId: 1,
        optionId: 'deny',
        deciderType: 'human_user',
      },
      db,
    )

    expect(() =>
      decidePermissionRequest(
        {
          requestId: 'pr-1',
          workspaceId: 1,
          optionId: 'approve_readonly',
          deciderType: 'human_user',
        },
        db,
      ),
    ).toThrow('Permission request is denied')
  })

  it('expires stale pending requests before deciding', () => {
    createPermissionRequest(
      {
        id: 'expired-1',
        workspaceId: 1,
        requestType: 'local_cli_permission',
        title: 'Expired',
        prompt: 'Expired prompt',
        risk: 'low',
        expiresAt: 1,
        options: [
          { id: 'approve', label: 'Approve', action: 'approve' },
          { id: 'deny', label: 'Deny', action: 'deny' },
        ],
      },
      db,
    )

    expect(() =>
      decidePermissionRequest(
        {
          requestId: 'expired-1',
          workspaceId: 1,
          optionId: 'approve',
          deciderType: 'human_user',
        },
        db,
      ),
    ).toThrow('expired')
    expect(getPermissionRequest('expired-1', 1, db)?.status).toBe('expired')
  })

  it('allows steward agents to approve high risk requests when no dangerous action matches', () => {
    createPermissionRequest(
      {
        id: 'high-1',
        workspaceId: 1,
        requestType: 'local_cli_permission',
        title: 'High risk',
        prompt: 'Worker requests a broad but reversible analysis step.',
        risk: 'high',
        options: [
          { id: 'approve_full', label: 'Approve analysis', action: 'approve' },
          { id: 'deny', label: 'Deny', action: 'deny' },
        ],
      },
      db,
    )

    const approved = decidePermissionRequest(
      {
        requestId: 'high-1',
        workspaceId: 1,
        optionId: 'approve_full',
        deciderType: 'steward_agent',
        deciderAgentId: 'steward-9',
      },
      db,
    )
    expect(approved.status).toBe('approved')
  })

  it('prevents steward agents from approving dangerous action requests', () => {
    createPermissionRequest(
      {
        id: 'danger-1',
        workspaceId: 1,
        requestType: 'local_cli_permission',
        title: '删除目录',
        prompt: 'Worker requests rm -rf /tmp/build-cache.',
        risk: 'medium',
        options: [
          { id: 'approve_delete', label: 'Approve delete', action: 'approve' },
          { id: 'deny', label: 'Deny', action: 'deny' },
        ],
      },
      db,
    )

    expect(() =>
      decidePermissionRequest(
        {
          requestId: 'danger-1',
          workspaceId: 1,
          optionId: 'approve_delete',
          deciderType: 'steward_agent',
          deciderAgentId: 'steward-9',
        },
        db,
      ),
    ).toThrow('dangerous action')
    const pending = getPermissionRequest('danger-1', 1, db)
    expect(pending?.status).toBe('pending')
    expect(Array.isArray(pending?.context?.watch_event_audit)).toBe(true)
    expect((pending?.context?.watch_event as { notify_status?: string } | undefined)?.notify_status).toBe('failed')

    const denied = decidePermissionRequest(
      {
        requestId: 'danger-1',
        workspaceId: 1,
        optionId: 'deny',
        deciderType: 'steward_agent',
        deciderAgentId: 'steward-9',
      },
      db,
    )
    expect(denied.status).toBe('denied')
  })

  it.each(['high', 'critical'] as const)(
    'prevents steward agents from approving %s dangerous requests',
    (risk) => {
      const requestId = `danger-${risk}`
      createPermissionRequest(
        {
          id: requestId,
          workspaceId: 1,
          requestType: 'local_cli_permission',
          title: `${risk} destructive request`,
          prompt: 'Worker requests rm -rf /tmp/build-cache.',
          risk,
          options: [
            { id: 'approve_delete', label: 'Approve delete', action: 'approve' },
            { id: 'deny', label: 'Deny', action: 'deny' },
          ],
        },
        db,
      )

      expect(() =>
        decidePermissionRequest(
          {
            requestId,
            workspaceId: 1,
            optionId: 'approve_delete',
            deciderType: 'steward_agent',
            deciderAgentId: 'steward-9',
          },
          db,
        ),
      ).toThrow('dangerous action')
      expect(getPermissionRequest(requestId, 1, db)?.status).toBe('pending')
    },
  )

  it('records masked notification targets for dangerous action escalation', () => {
    createPermissionRequest(
      {
        id: 'danger-notify-1',
        workspaceId: 1,
        requestType: 'local_cli_permission',
        title: '删除目录',
        prompt: '删除 /tmp/build-cache',
        risk: 'low',
        options: [
          { id: 'approve_delete', label: 'Approve delete', action: 'approve' },
          { id: 'deny', label: 'Deny', action: 'deny' },
        ],
        context: {
          watch_event: {
            notification_targets: ['webhook:https://example.test/hook?token=secret-token'],
          },
        },
      },
      db,
    )

    expect(() =>
      decidePermissionRequest(
        {
          requestId: 'danger-notify-1',
          workspaceId: 1,
          optionId: 'approve_delete',
          deciderType: 'steward_agent',
        },
        db,
      ),
    ).toThrow('dangerous action')
    const current = getPermissionRequest('danger-notify-1', 1, db)
    expect((current?.context?.watch_event as { notify_status?: string } | undefined)?.notify_status).toBe('sent')
    const audit = current?.context?.watch_event_audit as Array<{ event_name?: string; targets?: string[] }> | undefined
    const sent = audit?.find((item) => item.event_name === 'human_notification_sent')
    expect(sent?.targets?.[0]).toContain('token=***')
    expect(sent?.targets?.[0]).not.toContain('secret-token')
  })

  it('records worker human replies as platform decisions', () => {
    createBase('worker-reply-1')
    const decided = recordWorkerHumanReply(
      {
        requestId: 'worker-reply-1',
        workspaceId: 1,
        sessionId: 'session-1',
        messageId: 'message-1',
        replyText: '批准只读',
        selectedOptionId: 'approve_readonly',
        operatorUserId: 7,
      },
      db,
    )

    expect(decided.status).toBe('approved')
    expect(decided.decider_type).toBe('human_user')
    expect(decided.decider_user_id).toBe(7)
    expect(decided.selected_option_id).toBe('approve_readonly')
    const audit = decided.context?.watch_event_audit
    expect(Array.isArray(audit)).toBe(true)
    expect((audit as Array<{ event_name?: string }>).map((item) => item.event_name)).toContain('worker_human_reply_received')
    expect((audit as Array<{ event_name?: string }>).map((item) => item.event_name)).toContain('decision_submitted')
  })

  it('does not let late worker replies change completed decisions', () => {
    createBase('late-reply-1')
    decidePermissionRequest(
      {
        requestId: 'late-reply-1',
        workspaceId: 1,
        optionId: 'deny',
        deciderType: 'human_user',
      },
      db,
    )

    expect(() =>
      recordWorkerHumanReply(
        {
          requestId: 'late-reply-1',
          workspaceId: 1,
          sessionId: 'session-1',
          messageId: 'message-2',
          replyText: '批准',
          selectedOptionId: 'approve_readonly',
        },
        db,
      ),
    ).toThrow('denied')
    const current = getPermissionRequest('late-reply-1', 1, db)
    expect(current?.status).toBe('denied')
    const audit = current?.context?.watch_event_audit as Array<{ event_name?: string }> | undefined
    expect(audit?.map((item) => item.event_name)).toContain('worker_human_reply_late')
  })

  it('waits for a permission decision event', async () => {
    createBase('wait-1')
    const waiting = waitForPermissionRequestDecision(
      {
        requestId: 'wait-1',
        workspaceId: 1,
        timeoutMs: 3000,
        pollIntervalMs: 250,
      },
      db,
    )

    setTimeout(() => {
      decidePermissionRequest(
        {
          requestId: 'wait-1',
          workspaceId: 1,
          optionId: 'deny',
          deciderType: 'human_user',
        },
        db,
      )
    }, 20)

    await expect(waiting).resolves.toMatchObject({
      id: 'wait-1',
      status: 'denied',
      selected_option_id: 'deny',
    })
  })

  it('patches permission request context without dropping existing context', () => {
    createBase('ctx-1')
    const updated = patchPermissionRequestContext(
      {
        requestId: 'ctx-1',
        workspaceId: 1,
        patch: {
          gateway_exec_forward: {
            status: 'failed',
            retryable: true,
          },
        },
      },
      db,
    )

    expect(updated.context?.cwd).toBe('/tmp/project')
    expect(updated.context?.gateway_exec_forward).toEqual({
      status: 'failed',
      retryable: true,
    })
  })
})
