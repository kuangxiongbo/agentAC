import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'
import { createSupervisionGoal, getSupervisionGoal, listSupervisionGoalEvents } from '@/lib/supervision-goals'
import { runSupervisionAutoPlanning } from '@/lib/supervision-plans'

describe('supervision auto planning', () => {
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

  function createGoal(id: string, requiresPlanApproval = false) {
    return createSupervisionGoal({
      id,
      workspaceId: 1,
      tenantId: 1,
      clientId: 'edge-a',
      stewardLocalAgentId: 7,
      title: 'Ship feature',
      objective: 'Implement and verify the feature',
      successCriteria: [{ id: 'sc-1', text: 'Tests pass' }],
      budget: {
        max_tasks: 4,
        max_parallel_workers: 2,
        max_retries_per_task: 2,
        max_replans: 2,
        max_runtime_seconds: 3600,
        max_model_calls: 20,
      },
      requiresPlanApproval,
      createdBy: '2',
    }, db)
  }

  const plan = {
    summary: 'Implement then verify',
    tasks: [
      {
        logical_key: 'implement',
        title: 'Implement',
        description: 'Implement the feature',
        dependencies: [],
        required_capabilities: ['backend'],
        preferred_framework: 'codex-cli' as const,
        goal_criteria: ['sc-1'],
        acceptance_criteria: ['Unit tests pass'],
        estimated_minutes: 30,
        risk: 'low' as const,
      },
    ],
  }

  it('auto-plans an autonomous goal and drives it to running without human action', async () => {
    createGoal('goal-auto', false)
    const runJudge = vi.fn(async () => ({ reply: JSON.stringify(plan), sessionId: 'steward-session', source: 'test' }))
    const summary = await runSupervisionAutoPlanning(
      {},
      { runJudge, isClientOnline: () => true },
      db,
    )
    expect(summary).toMatchObject({ processed: 1, planned: 1, skipped_offline: 0 })
    expect(getSupervisionGoal('goal-auto', 1, db)?.status).toBe('running')
    expect(runJudge).toHaveBeenCalledOnce()
  })

  it('auto-plans a half-autonomous goal but leaves it awaiting approval', async () => {
    createGoal('goal-approve', true)
    const runJudge = vi.fn(async () => ({ reply: JSON.stringify(plan), sessionId: 'steward-session', source: 'test' }))
    const summary = await runSupervisionAutoPlanning({}, { runJudge, isClientOnline: () => true }, db)
    expect(summary).toMatchObject({ processed: 1, planned: 1 })
    expect(getSupervisionGoal('goal-approve', 1, db)?.status).toBe('awaiting_plan_approval')
  })

  it('skips an offline steward without consuming a retry attempt', async () => {
    createGoal('goal-offline', false)
    const runJudge = vi.fn()
    const summary = await runSupervisionAutoPlanning({}, { runJudge, isClientOnline: () => false }, db)
    expect(summary).toMatchObject({ processed: 0, planned: 0, skipped_offline: 1 })
    expect(runJudge).not.toHaveBeenCalled()
    expect(getSupervisionGoal('goal-offline', 1, db)?.status).toBe('planning')
    expect(listSupervisionGoalEvents('goal-offline', 1, db).some(e => e.event_type === 'goal_auto_plan_failed')).toBe(false)
  })

  it('records a bounded failure and then cools down on generation error', async () => {
    createGoal('goal-fail', false)
    const runJudge = vi.fn(async () => { throw new Error('steward judge exploded') })
    const now = { t: 1_000_000 }
    const first = await runSupervisionAutoPlanning({}, { runJudge, isClientOnline: () => true, now: () => now.t }, db)
    expect(first).toMatchObject({ processed: 1, planned: 0 })
    expect(first.errors[0]).toContain('steward judge exploded')
    const failEvent = listSupervisionGoalEvents('goal-fail', 1, db).find(e => e.event_type === 'goal_auto_plan_failed')
    expect(failEvent).toBeTruthy()

    // Within cooldown window: skipped, judge not re-invoked.
    now.t += 60
    const second = await runSupervisionAutoPlanning({}, { runJudge, isClientOnline: () => true, now: () => now.t }, db)
    expect(second).toMatchObject({ processed: 0, skipped_cooldown: 1 })
    expect(runJudge).toHaveBeenCalledOnce()
  })
})
