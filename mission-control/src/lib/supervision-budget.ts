import type Database from 'better-sqlite3'
import { getDatabase } from './db'
import { getSupervisionGoal, listSupervisionGoals } from './supervision-goals'

function dbOr(database?: Database.Database) {
  return database ?? getDatabase()
}

export function getSupervisionBudgetViolations(
  goalId: string,
  workspaceId: number,
  now = Math.floor(Date.now() / 1000),
  database?: Database.Database,
): string[] {
  const goal = getSupervisionGoal(goalId, workspaceId, dbOr(database))
  if (!goal) throw new Error('Goal not found')
  const violations: string[] = []
  if (goal.deadline_at && now > goal.deadline_at) violations.push('GOAL_DEADLINE_EXCEEDED')
  if (now - goal.created_at > goal.budget.max_runtime_seconds) violations.push('GOAL_RUNTIME_BUDGET_EXCEEDED')
  if (Number(goal.usage.model_calls || 0) > goal.budget.max_model_calls) violations.push('GOAL_MODEL_CALL_BUDGET_EXCEEDED')
  if (goal.budget.max_estimated_cost != null && Number(goal.usage.estimated_cost || 0) > goal.budget.max_estimated_cost) {
    violations.push('GOAL_COST_BUDGET_EXCEEDED')
  }
  return violations
}

export function consumeSupervisionModelCall(
  input: { goalId: string; workspaceId: number; estimatedCost?: number; nowSeconds?: number },
  database?: Database.Database,
) {
  const db = dbOr(database)
  return db.transaction(() => {
    const goal = getSupervisionGoal(input.goalId, input.workspaceId, db)
    if (!goal) throw new Error('Goal not found')
    const now = input.nowSeconds ?? Math.floor(Date.now() / 1000)
    const violations = getSupervisionBudgetViolations(goal.id, goal.workspace_id, now, db)
    if (violations.length > 0) throw new Error(violations[0])
    const usage = { ...goal.usage }
    if (Number(usage.model_calls || 0) >= goal.budget.max_model_calls) {
      throw new Error('GOAL_MODEL_CALL_BUDGET_EXCEEDED')
    }
    if (
      goal.budget.max_estimated_cost != null
      && Number(usage.estimated_cost || 0) + Math.max(0, input.estimatedCost ?? 0) > goal.budget.max_estimated_cost
    ) {
      throw new Error('GOAL_COST_BUDGET_EXCEEDED')
    }
    usage.model_calls = Number(usage.model_calls || 0) + 1
    usage.estimated_cost = Number(usage.estimated_cost || 0) + Math.max(0, input.estimatedCost ?? 0)
    db.prepare(`
      UPDATE supervision_goals SET usage_json = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?
    `).run(JSON.stringify(usage), now, goal.id, goal.workspace_id)
    return usage
  })()
}

export function enforceSupervisionBudgets(
  input: { workspaceId?: number; nowSeconds?: number } = {},
  database?: Database.Database,
): { checked: number; blocked: number; violations: Array<{ goal_id: string; codes: string[] }> } {
  const db = dbOr(database)
  const workspaceId = input.workspaceId ?? 1
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000)
  const statuses = ['planning', 'awaiting_plan_approval', 'running', 'verifying'] as const
  const goals = statuses.flatMap((status) => listSupervisionGoals({ workspaceId, status, limit: 200 }, db).goals)
  const result = { checked: goals.length, blocked: 0, violations: [] as Array<{ goal_id: string; codes: string[] }> }
  for (const goal of goals) {
    const codes = getSupervisionBudgetViolations(goal.id, goal.workspace_id, now, db)
    if (codes.length === 0) continue
    result.violations.push({ goal_id: goal.id, codes })
    const updated = db.prepare(`
      UPDATE supervision_goals
      SET status = 'blocked', version = version + 1, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND status != 'blocked'
    `).run(now, goal.id, goal.workspace_id)
    if (updated.changes === 1) result.blocked++
    db.prepare(`
      INSERT OR IGNORE INTO supervision_events (
        workspace_id, tenant_id, goal_id, event_type, actor_type, actor_id,
        decision, reason, evidence_json, action_json, idempotency_key
      ) VALUES (?, ?, ?, 'goal_budget_exceeded', 'system', 'budget-enforcer',
        'escalate_human', ?, ?, ?, ?)
    `).run(
      goal.workspace_id,
      goal.tenant_id,
      goal.id,
      codes.join(', '),
      JSON.stringify({ codes, usage: goal.usage, budget: goal.budget, now }),
      JSON.stringify({ from_status: goal.status, to_status: 'blocked' }),
      `goal:${goal.id}:budget:${codes.sort().join(':')}`,
    )
  }
  return result
}
