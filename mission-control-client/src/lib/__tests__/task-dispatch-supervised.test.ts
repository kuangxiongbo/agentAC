import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'

const dbRef = vi.hoisted(() => ({ current: null as Database.Database | null }))

vi.mock('@/lib/db', () => ({
  getDatabase: () => dbRef.current,
  db_helpers: { logActivity: vi.fn() },
}))

import { autoRouteInboxTasks, dispatchAssignedTasks, requeueStaleTasks } from '@/lib/task-dispatch'

describe('supervised task legacy scheduler isolation', () => {
  let db: Database.Database
  const staleAt = Math.floor(Date.now() / 1000) - 20 * 60

  beforeEach(() => {
    db = new Database(':memory:')
    dbRef.current = db
    runMigrations(db)
    db.prepare(`
      INSERT INTO agents (id, name, role, status, workspace_id, created_at, updated_at)
      VALUES (5, 'worker-a', 'developer', 'idle', 1, ?, ?)
    `).run(staleAt, staleAt)
  })

  afterEach(() => db.close())

  it('does not auto-route a supervised inbox task', async () => {
    db.prepare(`
      INSERT INTO tasks (id, title, status, workspace_id, metadata, created_at, updated_at)
      VALUES (1, 'Supervised', 'inbox', 1, '{"goal_id":"goal-1"}', ?, ?)
    `).run(staleAt, staleAt)

    await autoRouteInboxTasks()

    expect(db.prepare(`SELECT status, assigned_to FROM tasks WHERE id = 1`).get())
      .toEqual({ status: 'inbox', assigned_to: null })
  })

  it('does not execute an assigned supervised task', async () => {
    db.prepare(`
      INSERT INTO tasks (id, title, status, assigned_to, workspace_id, metadata, created_at, updated_at)
      VALUES (2, 'Supervised', 'assigned', 'worker-a', 1, '{"goal_id":"goal-1"}', ?, ?)
    `).run(staleAt, staleAt)

    expect(await dispatchAssignedTasks()).toEqual({ ok: true, message: 'No assigned tasks to dispatch' })
    expect(db.prepare(`SELECT status, dispatch_attempts FROM tasks WHERE id = 2`).get())
      .toEqual({ status: 'assigned', dispatch_attempts: 0 })
  })

  it('does not requeue a stale supervised task', async () => {
    db.prepare(`UPDATE agents SET status = 'offline' WHERE id = 5`).run()
    db.prepare(`
      INSERT INTO tasks (id, title, status, assigned_to, workspace_id, metadata, created_at, updated_at)
      VALUES (3, 'Supervised', 'in_progress', 'worker-a', 1, '{"goal_id":"goal-1"}', ?, ?)
    `).run(staleAt, staleAt)

    await requeueStaleTasks()

    expect(db.prepare(`SELECT status, dispatch_attempts FROM tasks WHERE id = 3`).get())
      .toEqual({ status: 'in_progress', dispatch_attempts: 0 })
  })
})
