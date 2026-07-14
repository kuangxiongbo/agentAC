import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'
import {
  applySupervisionGoalAction,
  createSupervisionGoal,
  getSupervisionGoal,
  listSupervisionGoalEvents,
  listSupervisionGoals,
  updateSupervisionGoal,
} from '@/lib/supervision-goals'

describe('supervision goals', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    db.prepare(`
      INSERT INTO sync_agent_index (
        client_id, client_name, local_agent_id, original_name, remote_name,
        role, status, framework, session_key, updated_at
      ) VALUES ('edge-a', 'Mac', 7, 'Goal Steward', 'edge-a-Goal Steward',
        'human-watch', 'idle', 'codex', 'steward-session', unixepoch())
    `).run()
  })

  afterEach(() => db.close())

  function createGoal() {
    return createSupervisionGoal({
      id: 'goal-1',
      workspaceId: 1,
      tenantId: 1,
      clientId: 'edge-a',
      stewardLocalAgentId: 7,
      title: 'Complete release verification',
      objective: 'Build, test and verify the release',
      successCriteria: [{ id: 'sc-1', text: 'All tests pass', evidence_type: 'test' }],
      constraints: ['Do not delete production data'],
      allowedWorkerIds: [11, 12],
      priority: 'high',
      budget: {
        max_tasks: 8,
        max_parallel_workers: 2,
        max_retries_per_task: 3,
        max_replans: 5,
        max_runtime_seconds: 86400,
        max_model_calls: 100,
      },
      requiresPlanApproval: true,
      createdBy: '2',
    }, db)
  }

  it('creates and lists an audited goal for a human-watch steward', () => {
    const goal = createGoal()
    expect(goal).toMatchObject({
      id: 'goal-1',
      status: 'planning',
      version: 1,
      steward_session_id: 'steward-session',
      requires_plan_approval: true,
      allowed_worker_ids: [11, 12],
    })
    expect(listSupervisionGoals({ workspaceId: 1, tenantId: 1 }, db).total).toBe(1)
    expect(listSupervisionGoalEvents('goal-1', 1, db)).toHaveLength(1)
  })

  it('rejects a non-steward agent', () => {
    expect(() => createSupervisionGoal({
      workspaceId: 1,
      tenantId: 1,
      clientId: 'edge-a',
      stewardLocalAgentId: 99,
      title: 'Invalid',
      objective: 'Invalid steward',
      successCriteria: [{ id: 'sc-1', text: 'Never' }],
      budget: {
        max_tasks: 1,
        max_parallel_workers: 1,
        max_retries_per_task: 0,
        max_replans: 0,
        max_runtime_seconds: 60,
        max_model_calls: 1,
      },
      createdBy: '2',
    }, db)).toThrow('Steward must be a human-watch agent')
  })

  it('updates with optimistic locking and records an event', () => {
    createGoal()
    const updated = updateSupervisionGoal({
      goalId: 'goal-1',
      workspaceId: 1,
      expectedVersion: 1,
      actorId: '2',
      title: 'Updated release verification',
    }, db)
    expect(updated.version).toBe(2)
    expect(updated.title).toBe('Updated release verification')
    expect(() => updateSupervisionGoal({
      goalId: 'goal-1',
      workspaceId: 1,
      expectedVersion: 1,
      actorId: '2',
      title: 'Stale update',
    }, db)).toThrow('GOAL_STATE_CONFLICT')
    expect(listSupervisionGoalEvents('goal-1', 1, db)).toHaveLength(2)
  })

  it('enforces state transitions and completion evidence state', () => {
    createGoal()
    expect(() => applySupervisionGoalAction({
      goalId: 'goal-1',
      workspaceId: 1,
      expectedVersion: 1,
      action: 'accept_result',
      actorId: '2',
    }, db)).toThrow('Invalid goal transition')

    db.prepare(`UPDATE supervision_goals SET status='awaiting_plan_approval' WHERE id='goal-1'`).run()
    const running = applySupervisionGoalAction({
      goalId: 'goal-1',
      workspaceId: 1,
      expectedVersion: 1,
      action: 'approve_plan',
      actorId: '2',
      planVersion: 1,
    }, db)
    const verifying = applySupervisionGoalAction({
      goalId: 'goal-1',
      workspaceId: 1,
      expectedVersion: running.version,
      action: 'start_verification',
      actorId: '2',
    }, db)
    const completed = applySupervisionGoalAction({
      goalId: 'goal-1',
      workspaceId: 1,
      expectedVersion: verifying.version,
      action: 'accept_result',
      actorId: '2',
    }, db)
    expect(completed.status).toBe('completed')
    expect(completed.completed_at).toBeTypeOf('number')
    expect(getSupervisionGoal('goal-1', 1, db)?.current_plan_version).toBe(1)
  })
})
