import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'
import { consumeSupervisionModelCall, enforceSupervisionBudgets } from '@/lib/supervision-budget'
import { createSupervisionGoal, getSupervisionGoal, listSupervisionGoalEvents } from '@/lib/supervision-goals'

describe('supervision budget', () => {
  let db: Database.Database
  const now = 2_000_000_000

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    db.prepare(`
      INSERT INTO sync_agent_index (
        client_id, client_name, local_agent_id, original_name, remote_name,
        role, status, framework, session_key, updated_at
      ) VALUES ('edge-a', 'Mac', 7, 'Steward', 'edge-a-Steward',
        'human-watch', 'idle', 'codex', 'steward-session', ?)
    `).run(now)
  })

  afterEach(() => db.close())

  function goal(id: string, deadlineAt?: number) {
    const created = createSupervisionGoal({
      id,
      workspaceId: 1,
      tenantId: 1,
      clientId: 'edge-a',
      stewardLocalAgentId: 7,
      title: 'Budget goal',
      objective: 'Stay within budget',
      successCriteria: [{ id: 'sc-1', text: 'Complete safely' }],
      budget: {
        max_tasks: 2,
        max_parallel_workers: 1,
        max_retries_per_task: 1,
        max_replans: 1,
        max_runtime_seconds: 3600,
        max_model_calls: 1,
        max_estimated_cost: 0.5,
      },
      deadlineAt,
      createdBy: '2',
    }, db)
    db.prepare(`UPDATE supervision_goals SET created_at = ?, updated_at = ? WHERE id = ?`)
      .run(now, now, id)
    return created
  }

  it('allows the final budgeted model call and rejects the next one', () => {
    goal('goal-model')
    consumeSupervisionModelCall({
      goalId: 'goal-model',
      workspaceId: 1,
      estimatedCost: 0.2,
      nowSeconds: now,
    }, db)
    expect(getSupervisionGoal('goal-model', 1, db)?.usage).toMatchObject({
      model_calls: 1,
      estimated_cost: 0.2,
    })
    expect(() => consumeSupervisionModelCall({
      goalId: 'goal-model',
      workspaceId: 1,
      nowSeconds: now,
    }, db)).toThrow('GOAL_MODEL_CALL_BUDGET_EXCEEDED')
    expect(enforceSupervisionBudgets({ workspaceId: 1, nowSeconds: now }, db).blocked).toBe(0)
  })

  it('blocks expired goals and records an escalation event', () => {
    goal('goal-expired', now - 1)
    const result = enforceSupervisionBudgets({ workspaceId: 1, nowSeconds: now }, db)
    expect(result).toMatchObject({ checked: 1, blocked: 1 })
    expect(result.violations[0].codes).toContain('GOAL_DEADLINE_EXCEEDED')
    expect(getSupervisionGoal('goal-expired', 1, db)?.status).toBe('blocked')
    expect(listSupervisionGoalEvents('goal-expired', 1, db)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_type: 'goal_budget_exceeded', decision: 'escalate_human' }),
    ]))
  })

  it('rejects a model call whose estimated cost would exceed the limit', () => {
    goal('goal-cost')
    expect(() => consumeSupervisionModelCall({
      goalId: 'goal-cost',
      workspaceId: 1,
      estimatedCost: 0.6,
      nowSeconds: now,
    }, db)).toThrow('GOAL_COST_BUDGET_EXCEEDED')
  })
})
