import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'

const requireRole = vi.fn()
const mutationLimiter = vi.fn(() => null)

vi.mock('@/lib/auth', () => ({ requireRole }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter }))

describe('supervision worker task completion route', () => {
  let db: Database.Database

  beforeEach(() => {
    vi.resetModules()
    db = new Database(':memory:')
    runMigrations(db)
    requireRole.mockReturnValue({ user: { id: 1, workspace_id: 1, role: 'operator' } })
    mutationLimiter.mockReturnValue(null)
    vi.doMock('@/lib/db', () => ({ getDatabase: () => db }))
    db.prepare(`
      INSERT INTO supervision_goals (
        id, workspace_id, tenant_id, client_id, steward_local_agent_id,
        title, objective, success_criteria_json, constraints_json,
        allowed_workers_json, status, priority, budget_json, usage_json,
        current_plan_version, requires_plan_approval, created_by
      ) VALUES (
        'goal-worker', 1, NULL, 'edge-a', 7,
        'Goal', 'Objective', '[]', '[]', '[6]', 'running', 'medium',
        '{"max_tasks":3,"max_parallel_workers":1,"max_retries_per_task":1,"max_replans":1,"max_runtime_seconds":3600,"max_model_calls":20}',
        '{}', 1, 1, '1'
      )
    `).run()
    db.prepare(`
      INSERT INTO tasks (id, title, status, assigned_to, metadata, workspace_id, created_at, updated_at)
      VALUES (10, 'Worker task', 'in_progress', 'edge-worker', '{"goal_id":"goal-worker"}', 1, 1, 1)
    `).run()
    db.prepare(`
      INSERT INTO supervision_goal_tasks (
        goal_id, task_id, plan_version, logical_task_key, dependencies_json,
        acceptance_criteria_json, assigned_agent_id, assigned_session_id
      ) VALUES ('goal-worker', 10, 1, 'root', '[]', '["Evidence exists"]', '6', 'session-6')
    `).run()
  })

  afterEach(() => {
    db.close()
    vi.clearAllMocks()
  })

  it('records evidence and completes a task for its assigned Worker session', async () => {
    const route = await import('@/app/api/supervision/worker-tasks/[taskId]/complete/route')
    const response = await route.POST(new NextRequest('http://localhost/api/supervision/worker-tasks/10/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        goal_id: 'goal-worker',
        worker_local_agent_id: 6,
        worker_session_id: 'session-6',
        outcome: 'success',
        resolution: 'command exited 0',
        evidence: { command: 'node check.js', exit_code: 0, stdout: 'ok' },
      }),
    }), { params: Promise.resolve({ taskId: '10' }) })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, idempotent: false, task: { id: 10, status: 'done' } })
    expect(db.prepare('SELECT status, outcome, resolution FROM tasks WHERE id = 10').get())
      .toEqual({ status: 'done', outcome: 'success', resolution: 'command exited 0' })
    expect(db.prepare(`SELECT event_type, actor_id, decision FROM supervision_events WHERE task_id = 10`).get())
      .toEqual({ event_type: 'goal_task_worker_completed', actor_id: '6', decision: 'success' })
  })

  it('rejects a different Worker identity', async () => {
    const route = await import('@/app/api/supervision/worker-tasks/[taskId]/complete/route')
    const response = await route.POST(new NextRequest('http://localhost/api/supervision/worker-tasks/10/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        goal_id: 'goal-worker',
        worker_local_agent_id: 5,
        worker_session_id: 'session-6',
        resolution: 'not allowed',
      }),
    }), { params: Promise.resolve({ taskId: '10' }) })

    expect(response.status).toBe(403)
    expect(db.prepare('SELECT status FROM tasks WHERE id = 10').get()).toEqual({ status: 'in_progress' })
  })
})
