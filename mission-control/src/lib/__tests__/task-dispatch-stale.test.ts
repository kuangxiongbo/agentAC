import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'
import { createPermissionRequest } from '@/lib/permission-requests'

const dbRef = vi.hoisted(() => ({ current: null as Database.Database | null }))

vi.mock('@/lib/db', () => ({
  getDatabase: () => dbRef.current,
}))

import { requeueStaleTasks } from '@/lib/task-dispatch'

describe('requeueStaleTasks', () => {
  let db: Database.Database
  const staleUpdatedAt = Math.floor(Date.now() / 1000) - 20 * 60 // 20 minutes ago

  beforeEach(() => {
    db = new Database(':memory:')
    dbRef.current = db
    runMigrations(db)

    db.prepare(`
      INSERT INTO agents (id, name, role, status, workspace_id, created_at, updated_at)
      VALUES (5, 'worker-a', 'developer', 'offline', 1, ?, ?)
    `).run(staleUpdatedAt, staleUpdatedAt)
  })

  afterEach(() => {
    db.close()
  })

  it('requeues a stale in_progress task when the agent is offline with no pending approval', async () => {
    db.prepare(`
      INSERT INTO tasks (id, title, status, assigned_to, workspace_id, dispatch_attempts, created_at, updated_at)
      VALUES (1, 'Do thing', 'in_progress', 'worker-a', 1, 0, ?, ?)
    `).run(staleUpdatedAt, staleUpdatedAt)

    const result = await requeueStaleTasks()

    expect(result.ok).toBe(true)
    const task = db.prepare('SELECT status FROM tasks WHERE id = 1').get() as { status: string }
    expect(task.status).toBe('assigned')
  })

  it('does not requeue a stale task whose agent is blocked on a pending permission request', async () => {
    db.prepare(`
      INSERT INTO tasks (id, title, status, assigned_to, workspace_id, dispatch_attempts, created_at, updated_at)
      VALUES (2, 'Do risky thing', 'in_progress', 'worker-a', 1, 0, ?, ?)
    `).run(staleUpdatedAt, staleUpdatedAt)

    createPermissionRequest(
      {
        id: 'pr-stale-1',
        workspaceId: 1,
        tenantId: 1,
        clientId: 'edge-a',
        workerLocalAgentId: 5,
        workerName: 'worker-a',
        workerSessionId: 'sess-a',
        requestType: 'local_cli_permission',
        title: '需要确认',
        prompt: 'Worker 正在等待是否继续执行。',
        risk: 'high',
        options: [
          { id: 'approve_once', label: '批准', action: 'approve' },
          { id: 'deny', label: '拒绝', action: 'deny' },
        ],
      },
      db,
    )

    const result = await requeueStaleTasks()

    expect(result.ok).toBe(true)
    expect(result.message).toContain('awaiting human approval')
    const task = db.prepare('SELECT status FROM tasks WHERE id = 2').get() as { status: string }
    expect(task.status).toBe('in_progress')
  })
})
