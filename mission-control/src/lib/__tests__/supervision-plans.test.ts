import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'
import { createSupervisionGoal, getSupervisionGoal } from '@/lib/supervision-goals'
import {
  generateSupervisionGoalPlan,
  listSupervisionGoalPlans,
  saveSupervisionGoalPlan,
  validateSupervisionGoalPlan,
} from '@/lib/supervision-plans'

describe('supervision plans', () => {
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

  function createGoal(requiresPlanApproval = true) {
    return createSupervisionGoal({
      id: 'goal-plan',
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
        acceptance_criteria: ['Unit tests pass'],
        estimated_minutes: 30,
        risk: 'low' as const,
      },
      {
        logical_key: 'verify',
        title: 'Verify',
        description: 'Run integration verification',
        dependencies: ['implement'],
        required_capabilities: ['testing'],
        acceptance_criteria: ['Integration tests pass'],
        risk: 'low' as const,
      },
    ],
  }

  it('validates DAGs and budget limits', () => {
    expect(validateSupervisionGoalPlan(plan, createGoal().budget).tasks).toHaveLength(2)
    expect(() => validateSupervisionGoalPlan({
      summary: 'cycle',
      tasks: [
        { ...plan.tasks[0], dependencies: ['verify'] },
        { ...plan.tasks[1], dependencies: ['implement'] },
      ],
    }, getSupervisionGoal('goal-plan', 1, db)!.budget)).toThrow('PLAN_DEPENDENCY_CYCLE')
  })

  it('saves an immutable plan and waits for approval', () => {
    createGoal()
    const saved = saveSupervisionGoalPlan({
      goalId: 'goal-plan',
      workspaceId: 1,
      draft: plan,
      createdByType: 'human_user',
      actorId: '2',
    }, db)
    expect(saved).toMatchObject({ version: 1, status: 'draft' })
    expect(getSupervisionGoal('goal-plan', 1, db)).toMatchObject({
      status: 'awaiting_plan_approval',
      current_plan_version: 1,
      version: 2,
    })
    expect(listSupervisionGoalPlans('goal-plan', 1, db)).toHaveLength(1)
  })

  it('generates and parses a fenced JSON plan from the steward', async () => {
    createGoal(false)
    const runJudge = vi.fn(async () => ({
      reply: `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``,
      sessionId: 'steward-session',
      source: 'test',
    }))
    const saved = await generateSupervisionGoalPlan({
      goalId: 'goal-plan',
      workspaceId: 1,
    }, { runJudge }, db)
    expect(runJudge).toHaveBeenCalledOnce()
    expect(saved.status).toBe('approved')
    expect(getSupervisionGoal('goal-plan', 1, db)?.status).toBe('running')
    expect(getSupervisionGoal('goal-plan', 1, db)?.usage).toMatchObject({ model_calls: 1 })
  })

  it('forces human approval for high-risk tasks even when auto approval is configured', () => {
    createGoal(false)
    const saved = saveSupervisionGoalPlan({
      goalId: 'goal-plan',
      workspaceId: 1,
      draft: {
        ...plan,
        tasks: [{ ...plan.tasks[0], risk: 'high' as const }],
      },
      createdByType: 'steward_agent',
    }, db)
    expect(saved.status).toBe('draft')
    expect(getSupervisionGoal('goal-plan', 1, db)?.status).toBe('awaiting_plan_approval')
  })
})
