import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'
import { createPermissionRequest } from '@/lib/permission-requests'

const dbRef = vi.hoisted(() => ({ current: null as Database.Database | null }))

vi.mock('@/lib/db', () => ({
  getDatabase: () => dbRef.current,
  db_helpers: {
    logActivity: vi.fn(),
  },
}))

import {
  autoRouteInboxTasks,
  dispatchAssignedTasks,
  isSupervisedGoalTask,
  requeueStaleTasks,
} from '@/lib/task-dispatch'

describe('requeueStaleTasks', () => {
  let db: Database.Database
  const staleUpdatedAt = Math.floor(Date.now() / 1000) - 20 * 60 // 20 minutes ago

  function markSupervised(taskId: number) {
    db.prepare(`
      INSERT INTO supervision_goal_tasks (goal_id, task_id, plan_version, logical_task_key)
      VALUES ('goal-1', ?, 1, ?)
    `).run(taskId, `task-${taskId}`)
  }

  beforeEach(() => {
    db = new Database(':memory:')
    dbRef.current = db
    runMigrations(db)

    db.prepare(`
      INSERT INTO agents (id, name, role, status, workspace_id, created_at, updated_at)
      VALUES (5, 'worker-a', 'developer', 'offline', 1, ?, ?)
    `).run(staleUpdatedAt, staleUpdatedAt)
    db.prepare(`
      INSERT INTO supervision_goals (
        id, workspace_id, client_id, steward_local_agent_id, title, objective,
        success_criteria_json, budget_json, created_by
      ) VALUES ('goal-1', 1, 'edge-a', 7, 'Goal', 'Objective', '[]', '{}', 'test')
    `).run()
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

  it('does not auto-route supervised goal tasks through the legacy scheduler', async () => {
    db.prepare(`UPDATE agents SET status = 'idle' WHERE id = 5`).run()
    db.prepare(`
      INSERT INTO tasks (id, title, status, workspace_id, metadata, created_by, created_at, updated_at)
      VALUES
        (3, 'Supervised work', 'inbox', 1, '{}', 'goal-supervisor', ?, ?),
        (4, 'Ordinary work', 'inbox', 1, '{}', 'test', ?, ?)
    `).run(staleUpdatedAt, staleUpdatedAt, staleUpdatedAt, staleUpdatedAt)
    markSupervised(3)

    const result = await autoRouteInboxTasks()

    expect(result.ok).toBe(true)
    const supervised = db.prepare(`SELECT status, assigned_to FROM tasks WHERE id = 3`).get() as {
      status: string
      assigned_to: string | null
    }
    const ordinary = db.prepare(`SELECT status, assigned_to FROM tasks WHERE id = 4`).get() as {
      status: string
      assigned_to: string | null
    }
    expect(supervised).toEqual({ status: 'inbox', assigned_to: null })
    expect(ordinary).toEqual({ status: 'assigned', assigned_to: 'worker-a' })
  })

  it('rejects supervised tasks at the final mutation guard', () => {
    db.prepare(`
      INSERT INTO tasks (id, title, status, workspace_id, metadata, created_at, updated_at)
      VALUES
        (7, 'Relational supervision', 'inbox', 1, '{}', ?, ?),
        (8, 'Metadata supervision', 'inbox', 1, '{"goal_id":"goal-meta"}', ?, ?),
        (9, 'Ordinary task', 'inbox', 1, '{}', ?, ?)
    `).run(staleUpdatedAt, staleUpdatedAt, staleUpdatedAt, staleUpdatedAt, staleUpdatedAt, staleUpdatedAt)
    markSupervised(7)

    expect(isSupervisedGoalTask(7, db)).toBe(true)
    expect(isSupervisedGoalTask(8, db)).toBe(true)
    expect(isSupervisedGoalTask(9, db)).toBe(false)
  })

  it('does not requeue a stale supervised task through the legacy scheduler', async () => {
    db.prepare(`
      INSERT INTO tasks (id, title, status, assigned_to, workspace_id, metadata, dispatch_attempts, created_at, updated_at)
      VALUES (5, 'Supervised stale work', 'in_progress', 'worker-a', 1, '{}', 0, ?, ?)
    `).run(staleUpdatedAt, staleUpdatedAt)
    markSupervised(5)

    const result = await requeueStaleTasks()

    expect(result.ok).toBe(true)
    const task = db.prepare(`SELECT status, dispatch_attempts FROM tasks WHERE id = 5`).get()
    expect(task).toEqual({ status: 'in_progress', dispatch_attempts: 0 })
  })

  it('does not execute an assigned supervised task through the legacy dispatcher', async () => {
    db.prepare(`UPDATE agents SET status = 'idle' WHERE id = 5`).run()
    db.prepare(`
      INSERT INTO tasks (id, title, status, assigned_to, workspace_id, metadata, dispatch_attempts, created_at, updated_at)
      VALUES (6, 'Supervised assigned work', 'assigned', 'worker-a', 1, '{}', 0, ?, ?)
    `).run(staleUpdatedAt, staleUpdatedAt)
    markSupervised(6)

    const result = await dispatchAssignedTasks()

    expect(result).toEqual({ ok: true, message: 'No assigned tasks to dispatch' })
    const task = db.prepare(`SELECT status, dispatch_attempts, error_message FROM tasks WHERE id = 6`).get()
    expect(task).toEqual({ status: 'assigned', dispatch_attempts: 0, error_message: null })
  })
})
