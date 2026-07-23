import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'
import { applySupervisionCorrection, runSupervisionCorrections } from '@/lib/supervision-corrections'
import { dispatchSupervisionGoal } from '@/lib/supervision-dispatcher'
import { createSupervisionGoal, getSupervisionGoal, listSupervisionGoalEvents } from '@/lib/supervision-goals'
import { saveSupervisionGoalPlan } from '@/lib/supervision-plans'

describe('supervision corrections', () => {
  let db: Database.Database
  let taskId: number

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    const now = Math.floor(Date.now() / 1000)
    const index = db.prepare(`
      INSERT INTO sync_agent_index (
        client_id, client_name, local_agent_id, original_name, remote_name,
        role, status, framework, session_key, updated_at
      ) VALUES ('edge-a', 'Mac', ?, ?, ?, ?, 'idle', 'codex', ?, ?)
    `)
    index.run(7, 'Steward', 'edge-a-Steward', 'human-watch', 'steward-session', now)
    index.run(11, 'Worker A', 'edge-a-Worker A', 'developer', 'worker-a-session', now)
    index.run(12, 'Worker B', 'edge-a-Worker B', 'developer', 'worker-b-session', now)
    const mirror = db.prepare(`
      INSERT INTO agents (
        name, role, status, config, workspace_id, source, node_id, framework, hidden
      ) VALUES (?, 'developer', 'idle', ?, 1, 'client', 'edge-a', 'codex', 0)
    `)
    mirror.run('mac-worker-a', JSON.stringify({ local_agent_id: 11, original_name: 'Worker A', capabilities: ['backend'] }))
    mirror.run('mac-worker-b', JSON.stringify({ local_agent_id: 12, original_name: 'Worker B', capabilities: ['backend'] }))
    createSupervisionGoal({
      id: 'goal-correct',
      workspaceId: 1,
      tenantId: 1,
      clientId: 'edge-a',
      stewardLocalAgentId: 7,
      title: 'Correct feature',
      objective: 'Implement the backend correctly',
      successCriteria: [{ id: 'sc-1', text: 'Tests pass' }],
      budget: {
        max_tasks: 2,
        max_parallel_workers: 1,
        max_retries_per_task: 1,
        max_replans: 1,
        max_runtime_seconds: 3600,
        max_model_calls: 10,
      },
      requiresPlanApproval: false,
      createdBy: '2',
    }, db)
    saveSupervisionGoalPlan({
      goalId: 'goal-correct',
      workspaceId: 1,
      createdByType: 'human_user',
      draft: {
        summary: 'Implement',
        tasks: [{
          logical_key: 'implement',
          title: 'Implement backend',
          description: 'Implement endpoint and tests',
          dependencies: [],
          required_capabilities: ['backend'],
          acceptance_criteria: ['Tests pass'],
          risk: 'low',
        }],
      },
    }, db)
    taskId = dispatchSupervisionGoal({ goalId: 'goal-correct', workspaceId: 1 }, {
      isClientOnline: () => true,
      wakeup: () => true,
    }, db).tasks[0].task_id
  })

  afterEach(() => db.close())

  function observation(eventType: string, reason: string): number {
    return Number(db.prepare(`
      INSERT INTO supervision_events (
        workspace_id, tenant_id, goal_id, task_id, event_type,
        actor_type, decision, reason, idempotency_key
      ) VALUES (1, 1, 'goal-correct', ?, ?, 'system', 'needs_correction', ?, ?)
    `).run(taskId, eventType, reason, `test:${eventType}:${Date.now()}`).lastInsertRowid)
  }

  it('applies a semantic correction once through the reliable mailbox', () => {
    const eventId = observation('worker_output_deviation_detected', 'Worker changed unrelated files')
    const wakeup = vi.fn(() => true)
    const first = runSupervisionCorrections({ workspaceId: 1 }, {
      isClientOnline: () => true,
      wakeup,
    }, db)
    expect(first).toMatchObject({ processed: 1, applied: 1, escalated: 0 })
    expect((db.prepare(`SELECT COUNT(*) AS count FROM edge_messages`).get() as { count: number }).count).toBe(2)
    const correctionMessage = db.prepare(`
      SELECT payload_json FROM edge_messages
      WHERE type = 'session.continue.requested'
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get() as { payload_json: string }
    expect(JSON.parse(correctionMessage.payload_json)).toMatchObject({
      session_id: 'worker-a-session',
      session_kind: 'codex-cli',
      worker_local_agent_id: 11,
      execution_timeout_ms: 1_800_000,
    })
    expect(wakeup).toHaveBeenCalledOnce()
    expect(listSupervisionGoalEvents('goal-correct', 1, db)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event_type: 'supervision_correction_applied',
        decision: 'correct_direction',
        correlation_id: `supervision-event:${eventId}`,
      }),
    ]))

    const repeated = runSupervisionCorrections({ workspaceId: 1 }, {
      isClientOnline: () => true,
      wakeup,
    }, db)
    expect(repeated.processed).toBe(0)
    expect((db.prepare(`SELECT COUNT(*) AS count FROM edge_messages`).get() as { count: number }).count).toBe(2)
  })

  it('does not continue a terminal task for a stale semantic observation', () => {
    observation('worker_output_insufficient', 'Completion evidence was not quoted in the Worker summary')
    db.prepare(`UPDATE tasks SET status = 'done', outcome = 'success' WHERE id = ?`).run(taskId)
    const wakeup = vi.fn(() => true)

    const result = runSupervisionCorrections({ workspaceId: 1 }, { wakeup }, db)

    expect(result).toEqual({ processed: 0, applied: 0, escalated: 0, errors: [] })
    expect(wakeup).not.toHaveBeenCalled()
    expect((db.prepare(`SELECT COUNT(*) AS count FROM edge_messages`).get() as { count: number }).count).toBe(1)
  })

  it('reassigns an offline worker and enforces retry and replan budgets', () => {
    observation('worker_offline_detected', 'Worker A is offline')
    const corrected = runSupervisionCorrections({ workspaceId: 1 }, {
      isClientOnline: () => true,
      wakeup: () => true,
    }, db)
    expect(corrected.applied).toBe(1)
    const relation = db.prepare(`
      SELECT assigned_agent_id, reassignment_count
      FROM supervision_goal_tasks WHERE goal_id = 'goal-correct' AND task_id = ?
    `).get(taskId) as { assigned_agent_id: string; reassignment_count: number }
    expect(relation).toEqual({ assigned_agent_id: '12', reassignment_count: 1 })

    applySupervisionCorrection({
      goalId: 'goal-correct',
      workspaceId: 1,
      taskId,
      action: 'retry_task',
      reason: 'Retry after transient failure',
    }, { wakeup: () => true }, db)
    expect(() => applySupervisionCorrection({
      goalId: 'goal-correct',
      workspaceId: 1,
      taskId,
      action: 'retry_task',
      reason: 'Retry again',
    }, { wakeup: () => true }, db)).toThrow('GOAL_TASK_RETRY_BUDGET_EXCEEDED')

    applySupervisionCorrection({
      goalId: 'goal-correct',
      workspaceId: 1,
      action: 'request_replan',
      reason: 'Current plan cannot succeed',
    }, {}, db)
    expect(getSupervisionGoal('goal-correct', 1, db)).toMatchObject({ status: 'planning' })
  })

  it('escalates to a human when automatic reassignment has no candidate', () => {
    db.prepare(`DELETE FROM sync_agent_index WHERE local_agent_id = 12`).run()
    const eventId = observation('worker_offline_detected', 'Only worker is offline')
    const result = runSupervisionCorrections({ workspaceId: 1 }, {
      isClientOnline: () => true,
      wakeup: () => true,
    }, db)
    expect(result).toMatchObject({ processed: 1, applied: 0, escalated: 1 })
    expect(result.errors[0]).toContain('NO_REASSIGNMENT_WORKER_AVAILABLE')
    expect(getSupervisionGoal('goal-correct', 1, db)?.status).toBe('blocked')
    expect(listSupervisionGoalEvents('goal-correct', 1, db)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        decision: 'escalate_human',
        correlation_id: `supervision-event:${eventId}`,
      }),
    ]))
  })
})
