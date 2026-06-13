import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'
import { createPermissionRequest, getPermissionRequest } from '@/lib/permission-requests'
import {
  forwardPermissionDecisionToExecApproval,
  mapPermissionOptionToExecAction,
} from '@/lib/permission-request-exec-bridge'

describe('permission-request-exec-bridge', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
  })

  afterEach(() => {
    db.close()
  })

  it('maps platform options to gateway exec approval actions', () => {
    expect(mapPermissionOptionToExecAction({ id: 'approve_once', label: 'Allow once', action: 'approve' })).toBe('approve')
    expect(mapPermissionOptionToExecAction({ id: 'always_allow', label: 'Always allow', action: 'approve' })).toBe('always_allow')
    expect(mapPermissionOptionToExecAction({ id: 'deny', label: 'Deny', action: 'deny' })).toBe('deny')
    expect(mapPermissionOptionToExecAction({ id: 'ask', label: 'Ask human', action: 'ask_human' })).toBe('deny')
  })

  it('records failed gateway forwarding as retryable context', async () => {
    const request = createPermissionRequest(
      {
        id: 'exec-forward-1',
        workspaceId: 1,
        requestType: 'gateway_exec_approval',
        title: 'Exec approval',
        prompt: 'Run command',
        risk: 'medium',
        options: [
          { id: 'approve_once', label: 'Allow once', action: 'approve' },
          { id: 'deny', label: 'Deny', action: 'deny' },
        ],
        context: { gateway_exec_approval_id: 'gw-1' },
      },
      db,
    )

    const result = await forwardPermissionDecisionToExecApproval({
      request,
      option: request.options[0],
      reason: 'test',
      database: db,
    })

    expect(result.status).toBe('failed')
    const updated = getPermissionRequest('exec-forward-1', 1, db)
    expect(updated?.context?.gateway_exec_forward).toMatchObject({
      status: 'failed',
      exec_approval_id: 'gw-1',
      retryable: true,
    })
  })
})
