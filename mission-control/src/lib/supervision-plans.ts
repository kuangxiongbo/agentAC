import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getDatabase } from './db'
import { requestBridgeClientStewardJudge } from './bridge-server'
import {
  getSupervisionGoal,
  type SupervisionGoalBudget,
  type SupervisionGoalView,
} from './supervision-goals'
import { supervisionGoalPlanDraftSchema } from './supervision-validation'
import { consumeSupervisionModelCall } from './supervision-budget'
import { searchStewardMemories } from './steward-memory-search'

export interface SupervisionPlanTask {
  logical_key: string
  title: string
  description: string
  dependencies: string[]
  required_capabilities: string[]
  preferred_framework?: 'claude-code' | 'codex-cli' | 'hermes'
  goal_criteria: string[]
  acceptance_criteria: string[]
  estimated_minutes?: number
  risk: 'low' | 'medium' | 'high' | 'critical'
}

export interface SupervisionGoalPlanDraft {
  summary: string
  tasks: SupervisionPlanTask[]
}

export interface SupervisionGoalPlanRow {
  id: string
  goal_id: string
  version: number
  status: 'draft' | 'approved' | 'superseded' | 'rejected'
  plan_json: string
  rationale: string | null
  source_event_id: number | null
  created_by_type: 'human_user' | 'steward_agent' | 'system'
  created_at: number
}

export interface SupervisionGoalPlanView extends Omit<SupervisionGoalPlanRow, 'plan_json'> {
  plan: SupervisionGoalPlanDraft
}

type JudgeRunner = typeof requestBridgeClientStewardJudge

function dbOr(database?: Database.Database) {
  return database ?? getDatabase()
}

function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()
  const candidate = fenced || trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1)
  if (!candidate || !candidate.startsWith('{') || !candidate.endsWith('}')) {
    throw new Error('PLAN_SCHEMA_INVALID: steward response did not contain a JSON object')
  }
  try {
    return JSON.parse(candidate)
  } catch {
    throw new Error('PLAN_SCHEMA_INVALID: steward response was not valid JSON')
  }
}

function assertAcyclic(tasks: SupervisionPlanTask[]) {
  const keys = new Set(tasks.map((task) => task.logical_key))
  if (keys.size !== tasks.length) throw new Error('PLAN_SCHEMA_INVALID: duplicate logical_key')
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!keys.has(dependency)) {
        throw new Error(`PLAN_SCHEMA_INVALID: unknown dependency ${dependency}`)
      }
      if (dependency === task.logical_key) {
        throw new Error(`PLAN_DEPENDENCY_CYCLE: ${task.logical_key}`)
      }
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const taskMap = new Map(tasks.map((task) => [task.logical_key, task]))
  const visit = (key: string) => {
    if (visiting.has(key)) throw new Error(`PLAN_DEPENDENCY_CYCLE: ${key}`)
    if (visited.has(key)) return
    visiting.add(key)
    for (const dependency of taskMap.get(key)?.dependencies ?? []) visit(dependency)
    visiting.delete(key)
    visited.add(key)
  }
  for (const key of keys) visit(key)
}

export function validateSupervisionGoalPlan(
  raw: unknown,
  budget: SupervisionGoalBudget,
  goalCriterionIds: string[] = [],
): SupervisionGoalPlanDraft {
  const parsed = supervisionGoalPlanDraftSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`PLAN_SCHEMA_INVALID: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
  }
  if (parsed.data.tasks.length > budget.max_tasks) {
    throw new Error(`GOAL_BUDGET_EXCEEDED: plan has ${parsed.data.tasks.length} tasks, max is ${budget.max_tasks}`)
  }
  assertAcyclic(parsed.data.tasks)
  if (goalCriterionIds.length > 0) {
    const expected = new Set(goalCriterionIds)
    const covered = new Set<string>()
    for (const task of parsed.data.tasks) {
      for (const criterionId of task.goal_criteria) {
        if (!expected.has(criterionId)) {
          throw new Error(`PLAN_SCHEMA_INVALID: unknown goal criterion ${criterionId}`)
        }
        covered.add(criterionId)
      }
    }
    const missing = goalCriterionIds.filter((criterionId) => !covered.has(criterionId))
    if (missing.length > 0) {
      throw new Error(`PLAN_GOAL_CRITERIA_UNCOVERED: ${missing.join(', ')}`)
    }
  }
  return parsed.data
}

function buildPlanPrompt(goal: SupervisionGoalView, memoryContext = ''): string {
  return `你是目标监督值守 Agent。请把下面目标拆解为可分派给 Worker 的结构化任务计划。

只输出一个 JSON 对象，不要 Markdown、解释或前缀。JSON 必须符合：
{
  "summary": "计划摘要",
  "tasks": [{
    "logical_key": "kebab-case-key",
    "title": "任务标题",
    "description": "明确输入、工作内容和预期输出",
    "dependencies": ["前置 logical_key"],
    "required_capabilities": ["能力标签"],
    "preferred_framework": "codex-cli|claude-code|hermes",
    "goal_criteria": ["该任务负责达成的成功标准 ID"],
    "acceptance_criteria": ["可验证条件"],
    "estimated_minutes": 30,
    "risk": "low|medium|high|critical"
  }]
}

规则：
1. 最多 ${goal.budget.max_tasks} 个任务，依赖必须无环。
2. 每个任务必须通过 goal_criteria 映射到至少一条目标成功标准，整个计划必须覆盖全部成功标准。
3. 每个任务至少一条可验证验收标准，写清证据类型、获取方式和通过阈值，不能只写“完成”或“检查通过”。
4. 不把值守 Agent 自己作为执行者。
5. 高风险动作只可标记风险，不能假设已获批准。
6. 任务要足够独立，便于分给不同 Worker；最后必须能用独立证据验收目标效果，而不只是验收产出物存在。

目标：${goal.title}
目标描述：${goal.objective}
成功标准：${JSON.stringify(goal.success_criteria)}
约束：${JSON.stringify(goal.constraints)}
预算：${JSON.stringify(goal.budget)}
${memoryContext ? `\n已批准值守记忆（仅作参考，当前目标和安全约束优先）：\n${memoryContext}` : ''}`
}

function planView(row: SupervisionGoalPlanRow): SupervisionGoalPlanView {
  return { ...row, plan: JSON.parse(row.plan_json) as SupervisionGoalPlanDraft }
}

export function saveSupervisionGoalPlan(input: {
  goalId: string
  workspaceId: number
  draft: unknown
  rationale?: string | null
  sourceEventId?: number | null
  createdByType: SupervisionGoalPlanRow['created_by_type']
  actorId?: string | null
}, database?: Database.Database): SupervisionGoalPlanView {
  const db = dbOr(database)
  const goal = getSupervisionGoal(input.goalId, input.workspaceId, db)
  if (!goal) throw new Error('Goal not found')
  if (goal.status !== 'planning') throw new Error(`Invalid goal state for planning: ${goal.status}`)
  const plan = validateSupervisionGoalPlan(
    input.draft,
    goal.budget,
    goal.success_criteria.map((criterion) => criterion.id),
  )
  const now = Math.floor(Date.now() / 1000)
  return db.transaction(() => {
    const next = (db.prepare(`
      SELECT COALESCE(MAX(version), 0) + 1 AS version
      FROM supervision_goal_plans WHERE goal_id = ?
    `).get(goal.id) as { version: number }).version
    const hasHighRiskTask = plan.tasks.some((task) => task.risk === 'high' || task.risk === 'critical')
    const requiresApproval = goal.requires_plan_approval || hasHighRiskTask
    const planStatus = requiresApproval ? 'draft' : 'approved'
    const nextGoalStatus = requiresApproval ? 'awaiting_plan_approval' : 'running'
    const id = randomUUID()
    db.prepare(`
      INSERT INTO supervision_goal_plans (
        id, goal_id, version, status, plan_json, rationale,
        source_event_id, created_by_type, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      goal.id,
      next,
      planStatus,
      JSON.stringify(plan),
      input.rationale ?? null,
      input.sourceEventId ?? null,
      input.createdByType,
      now,
    )
    const updated = db.prepare(`
      UPDATE supervision_goals
      SET status = ?, current_plan_version = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND version = ? AND status = 'planning'
    `).run(nextGoalStatus, next, now, goal.id, goal.workspace_id, goal.version)
    if (updated.changes !== 1) throw new Error('GOAL_STATE_CONFLICT')
    db.prepare(`
      INSERT INTO supervision_events (
        workspace_id, tenant_id, goal_id, event_type, actor_type, actor_id,
        decision, reason, action_json, idempotency_key, created_at
      ) VALUES (?, ?, ?, 'plan_created', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      goal.workspace_id,
      goal.tenant_id,
      goal.id,
      input.createdByType,
      input.actorId ?? null,
      planStatus,
      input.rationale ?? null,
      JSON.stringify({ plan_id: id, plan_version: next, task_count: plan.tasks.length, goal_status: nextGoalStatus, high_risk_approval_required: hasHighRiskTask }),
      `goal:${goal.id}:plan:${next}:created`,
      now,
    )
    const row = db.prepare(`SELECT * FROM supervision_goal_plans WHERE id = ?`).get(id) as SupervisionGoalPlanRow
    return planView(row)
  })()
}

export async function generateSupervisionGoalPlan(input: {
  goalId: string
  workspaceId: number
  actorId?: string | null
  rationale?: string | null
}, deps: { runJudge?: JudgeRunner } = {}, database?: Database.Database): Promise<SupervisionGoalPlanView> {
  const db = dbOr(database)
  const goal = getSupervisionGoal(input.goalId, input.workspaceId, db)
  if (!goal) throw new Error('Goal not found')
  if (goal.status !== 'planning') throw new Error(`Invalid goal state for planning: ${goal.status}`)
  const memory = searchStewardMemories({
    workspaceId: goal.workspace_id,
    tenantId: goal.tenant_id,
    goalId: goal.id,
    query: `${goal.title} ${goal.objective} ${goal.constraints.join(' ')}`,
    categories: ['preference', 'fact', 'procedure', 'episode'],
    limit: 5,
    maxChars: 1800,
  }, db)
  consumeSupervisionModelCall({ goalId: goal.id, workspaceId: goal.workspace_id }, db)
  const runJudge = deps.runJudge ?? requestBridgeClientStewardJudge
  const result = await runJudge({
    clientId: goal.client_id,
    localAgentId: goal.steward_local_agent_id,
    prompt: buildPlanPrompt(goal, memory.context),
    timeoutMs: 600_000,
  })
  const rawPlan = extractJsonObject(result.reply)
  return saveSupervisionGoalPlan({
    goalId: goal.id,
    workspaceId: goal.workspace_id,
    draft: rawPlan,
    rationale: input.rationale ?? 'Generated by steward goal planner',
    createdByType: 'steward_agent',
    actorId: String(goal.steward_local_agent_id),
  }, db)
}

export function listSupervisionGoalPlans(
  goalId: string,
  workspaceId: number,
  database?: Database.Database,
): SupervisionGoalPlanView[] {
  const db = dbOr(database)
  const goal = getSupervisionGoal(goalId, workspaceId, db)
  if (!goal) return []
  const rows = db.prepare(`
    SELECT * FROM supervision_goal_plans
    WHERE goal_id = ? ORDER BY version DESC
  `).all(goalId) as SupervisionGoalPlanRow[]
  return rows.map(planView)
}
