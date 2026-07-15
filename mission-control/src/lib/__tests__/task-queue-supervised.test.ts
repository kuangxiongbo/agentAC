import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'

const requireRole = vi.fn()
const agentTaskLimiter = vi.fn(() => null)

vi.mock('@/lib/auth', () => ({ requireRole }))
vi.mock('@/lib/rate-limit', () => ({ agentTaskLimiter }))

describe('task queue supervised isolation', () => {
  let db: Database.Database

  beforeEach(() => {
    vi.resetModules()
    db = new Database(':memory:')
    runMigrations(db)
    requireRole.mockReturnValue({ user: { id: 1, workspace_id: 1, role: 'operator' } })
    agentTaskLimiter.mockReturnValue(null)
    vi.doMock('@/lib/db', () => ({ getDatabase: () => db }))
  })

  afterEach(() => {
    db.close()
    vi.clearAllMocks()
  })

  it('ignores active and queued supervised tasks when polling', async () => {
    db.prepare(`
      INSERT INTO supervision_goals (
        id, workspace_id, client_id, steward_local_agent_id, title, objective,
        success_criteria_json, budget_json, created_by
      ) VALUES ('goal-1', 1, 'edge-a', 7, 'Goal', 'Objective', '[]', '{}', 'test')
    `).run()
    db.prepare(`
      INSERT INTO tasks (id, title, status, assigned_to, metadata, workspace_id, created_at, updated_at)
      VALUES (1, 'Active supervised', 'in_progress', 'queue-agent', '{}', 1, 1, 1),
             (2, 'Queued supervised', 'inbox', NULL, '{}', 1, 2, 2),
             (3, 'Normal task', 'inbox', NULL, '{}', 1, 3, 3)
    `).run()
    db.prepare(`
      INSERT INTO supervision_goal_tasks (goal_id, task_id, plan_version, logical_task_key)
      VALUES ('goal-1', 1, 1, 'active'), ('goal-1', 2, 1, 'queued')
    `).run()
    const route = await import('@/app/api/tasks/queue/route')

    const response = await route.GET(new NextRequest(
      'http://localhost/api/tasks/queue?agent=queue-agent&max_capacity=1',
    ))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ reason: 'assigned', task: { id: 3, status: 'in_progress' } })
    expect(db.prepare('SELECT id, status, assigned_to FROM tasks WHERE id IN (1, 2) ORDER BY id').all())
      .toEqual([
        { id: 1, status: 'in_progress', assigned_to: 'queue-agent' },
        { id: 2, status: 'inbox', assigned_to: null },
      ])
  })
})
