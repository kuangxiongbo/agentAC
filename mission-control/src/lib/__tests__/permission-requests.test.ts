import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'
import {
  createPermissionRequest,
  decidePermissionRequest,
  getPermissionRequest,
  listPermissionRequests,
  patchPermissionRequestContext,
  waitForPermissionRequestDecision,
} from '@/lib/permission-requests'

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

  it('prevents steward agents from approving high risk requests', () => {
    createPermissionRequest(
      {
        id: 'high-1',
        workspaceId: 1,
        requestType: 'local_cli_permission',
        title: 'High risk',
        prompt: 'Worker requests destructive access.',
        risk: 'high',
        options: [
          { id: 'approve_full', label: 'Approve full access', action: 'approve' },
          { id: 'deny', label: 'Deny', action: 'deny' },
        ],
      },
      db,
    )

    expect(() =>
      decidePermissionRequest(
        {
          requestId: 'high-1',
          workspaceId: 1,
          optionId: 'approve_full',
          deciderType: 'steward_agent',
          deciderAgentId: 'steward-9',
        },
        db,
      ),
    ).toThrow('Steward agent cannot approve')
    expect(getPermissionRequest('high-1', 1, db)?.status).toBe('pending')

    const denied = decidePermissionRequest(
      {
        requestId: 'high-1',
        workspaceId: 1,
        optionId: 'deny',
        deciderType: 'steward_agent',
        deciderAgentId: 'steward-9',
      },
      db,
    )
    expect(denied.status).toBe('denied')
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
