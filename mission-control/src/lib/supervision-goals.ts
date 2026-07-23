import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getDatabase } from './db'

export type SupervisionGoalStatus =
  | 'draft'
  | 'planning'
  | 'awaiting_plan_approval'
  | 'running'
  | 'blocked'
  | 'paused'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type SupervisionGoalPriority = 'critical' | 'high' | 'medium' | 'low'

export interface SupervisionGoalCriterion {
  id: string
  text: string
  evidence_type?: 'test' | 'metric' | 'artifact' | 'review' | 'user_confirmation'
}

export interface SupervisionGoalBudget {
  max_tasks: number
  max_parallel_workers: number
  max_retries_per_task: number
  max_replans: number
  max_runtime_seconds: number
  max_model_calls: number
  max_estimated_cost?: number
}

export interface SupervisionGoalRow {
  id: string
  workspace_id: number
  tenant_id: number | null
  client_id: string
  steward_local_agent_id: number
  steward_session_id: string | null
  title: string
  objective: string
  success_criteria_json: string
  constraints_json: string
  allowed_workers_json: string
  status: SupervisionGoalStatus
  priority: SupervisionGoalPriority
  budget_json: string
  usage_json: string
  current_plan_version: number
  requires_plan_approval: number
  deadline_at: number | null
  created_by: string
  version: number
  created_at: number
  updated_at: number
  completed_at: number | null
}

export interface SupervisionGoalView extends Omit<
  SupervisionGoalRow,
  'success_criteria_json' | 'constraints_json' | 'allowed_workers_json' | 'budget_json' | 'usage_json' | 'requires_plan_approval'
> {
  success_criteria: SupervisionGoalCriterion[]
  constraints: string[]
  allowed_worker_ids: number[]
  budget: SupervisionGoalBudget
  usage: Record<string, unknown>
  requires_plan_approval: boolean
}

export interface CreateSupervisionGoalInput {
  workspaceId: number
  tenantId?: number | null
  clientId: string
  stewardLocalAgentId: number
  title: string
  objective: string
  successCriteria: SupervisionGoalCriterion[]
  constraints?: string[]
  allowedWorkerIds?: number[]
  priority?: SupervisionGoalPriority
  budget: SupervisionGoalBudget
  deadlineAt?: number | null
  requiresPlanApproval?: boolean
  createdBy: string
  id?: string
}

export interface UpdateSupervisionGoalInput {
  goalId: string
  workspaceId: number
  expectedVersion: number
  actorId: string
  title?: string
  objective?: string
  successCriteria?: SupervisionGoalCriterion[]
  constraints?: string[]
  allowedWorkerIds?: number[]
  priority?: SupervisionGoalPriority
  budget?: SupervisionGoalBudget
  deadlineAt?: number | null
  requiresPlanApproval?: boolean
}

export type SupervisionGoalAction =
  | 'start_planning'
  | 'approve_plan'
  | 'reject_plan'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'request_replan'
  | 'start_verification'
  | 'accept_result'
  | 'reject_result'
  | 'fail'

const ACTION_TARGETS: Record<SupervisionGoalAction, Partial<Record<SupervisionGoalStatus, SupervisionGoalStatus>>> = {
  start_planning: { draft: 'planning' },
  approve_plan: { awaiting_plan_approval: 'running' },
  reject_plan: { awaiting_plan_approval: 'planning' },
  pause: { planning: 'paused', awaiting_plan_approval: 'paused', running: 'paused', blocked: 'paused', verifying: 'paused' },
  resume: { paused: 'running', blocked: 'running' },
  cancel: { draft: 'cancelled', planning: 'cancelled', awaiting_plan_approval: 'cancelled', running: 'cancelled', blocked: 'cancelled', paused: 'cancelled', verifying: 'cancelled' },
  request_replan: { running: 'planning', blocked: 'planning', verifying: 'planning' },
  start_verification: { running: 'verifying' },
  accept_result: { verifying: 'completed' },
  reject_result: { verifying: 'running' },
  fail: { planning: 'failed', awaiting_plan_approval: 'failed', running: 'failed', blocked: 'failed', paused: 'failed', verifying: 'failed' },
}

function dbOr(database?: Database.Database) {
  return database ?? getDatabase()
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function view(row: SupervisionGoalRow): SupervisionGoalView {
  return {
    ...row,
    success_criteria: parseJson(row.success_criteria_json, [] as SupervisionGoalCriterion[]),
    constraints: parseJson(row.constraints_json, [] as string[]),
    allowed_worker_ids: parseJson(row.allowed_workers_json, [] as number[]),
    budget: parseJson(row.budget_json, {} as SupervisionGoalBudget),
    usage: parseJson(row.usage_json, {} as Record<string, unknown>),
    requires_plan_approval: Boolean(row.requires_plan_approval),
  }
}

function insertEvent(db: Database.Database, input: {
  workspaceId: number
  tenantId?: number | null
  goalId: string
  eventType: string
  actorType: string
  actorId?: string | null
  decision?: string | null
  reason?: string | null
  action?: Record<string, unknown> | null
  idempotencyKey?: string | null
}) {
  db.prepare(`
    INSERT INTO supervision_events (
      workspace_id, tenant_id, goal_id, event_type, actor_type, actor_id,
      decision, reason, action_json, idempotency_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.workspaceId,
    input.tenantId ?? null,
    input.goalId,
    input.eventType,
    input.actorType,
    input.actorId ?? null,
    input.decision ?? null,
    input.reason ?? null,
    input.action ? JSON.stringify(input.action) : null,
    input.idempotencyKey ?? null,
  )
}

function ensureSteward(db: Database.Database, input: {
  workspaceId: number
  tenantId?: number | null
  clientId: string
  stewardLocalAgentId: number
}) {
  const indexed = db.prepare(`
    SELECT role, session_key FROM sync_agent_index
    WHERE client_id = ? AND local_agent_id = ?
    LIMIT 1
  `).get(input.clientId, input.stewardLocalAgentId) as { role: string; session_key: string | null } | undefined
  const tenantFilter = input.tenantId == null ? '' : ' AND tenant_id = ?'
  const bindingParams = input.tenantId == null
    ? [input.workspaceId, input.clientId, input.stewardLocalAgentId]
    : [input.workspaceId, input.clientId, input.stewardLocalAgentId, input.tenantId]
  const binding = db.prepare(`
    SELECT id FROM human_watch_bindings
    WHERE workspace_id = ? AND client_id = ? AND steward_local_agent_id = ?${tenantFilter}
    LIMIT 1
  `).get(...bindingParams)
  if (indexed?.role !== 'human-watch' && !binding) {
    throw new Error('Steward must be a human-watch agent')
  }
  return indexed?.session_key ?? null
}

export function createSupervisionGoal(
  input: CreateSupervisionGoalInput,
  database?: Database.Database,
): SupervisionGoalView {
  const db = dbOr(database)
  const now = Math.floor(Date.now() / 1000)
  const id = input.id ?? randomUUID()
  const stewardSessionId = ensureSteward(db, input)
  const row = db.transaction(() => {
    db.prepare(`
      INSERT INTO supervision_goals (
        id, workspace_id, tenant_id, client_id, steward_local_agent_id,
        steward_session_id, title, objective, success_criteria_json,
        constraints_json, allowed_workers_json, status, priority, budget_json,
        usage_json, requires_plan_approval, deadline_at, created_by,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planning', ?, ?, '{}', ?, ?, ?, ?, ?)
    `).run(
      id,
      input.workspaceId,
      input.tenantId ?? null,
      input.clientId,
      input.stewardLocalAgentId,
      stewardSessionId,
      input.title.trim(),
      input.objective.trim(),
      JSON.stringify(input.successCriteria),
      JSON.stringify(input.constraints ?? []),
      JSON.stringify(input.allowedWorkerIds ?? []),
      input.priority ?? 'medium',
      JSON.stringify(input.budget),
      input.requiresPlanApproval === false ? 0 : 1,
      input.deadlineAt ?? null,
      input.createdBy,
      now,
      now,
    )
    insertEvent(db, {
      workspaceId: input.workspaceId,
      tenantId: input.tenantId,
      goalId: id,
      eventType: 'goal_created',
      actorType: 'human_user',
      actorId: input.createdBy,
      decision: 'planning',
      action: { status: 'planning' },
      idempotencyKey: `goal:${id}:created`,
    })
    return getSupervisionGoal(id, input.workspaceId, db)
  })()
  if (!row) throw new Error('Goal not found after create')
  return row
}

export function getSupervisionGoal(
  goalId: string,
  workspaceId: number,
  database?: Database.Database,
): SupervisionGoalView | null {
  const row = dbOr(database).prepare(`
    SELECT * FROM supervision_goals WHERE id = ? AND workspace_id = ? LIMIT 1
  `).get(goalId, workspaceId) as SupervisionGoalRow | undefined
  return row ? view(row) : null
}

export function listSupervisionGoals(input: {
  workspaceId: number
  tenantId?: number | null
  status?: SupervisionGoalStatus
  stewardLocalAgentId?: number
  limit?: number
  offset?: number
}, database?: Database.Database): { goals: SupervisionGoalView[]; total: number } {
  const db = dbOr(database)
  const clauses = ['workspace_id = ?']
  const params: Array<string | number> = [input.workspaceId]
  if (input.tenantId != null) {
    clauses.push('tenant_id = ?')
    params.push(input.tenantId)
  }
  if (input.status) {
    clauses.push('status = ?')
    params.push(input.status)
  }
  if (input.stewardLocalAgentId) {
    clauses.push('steward_local_agent_id = ?')
    params.push(input.stewardLocalAgentId)
  }
  const where = clauses.join(' AND ')
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM supervision_goals WHERE ${where}`)
    .get(...params) as { count: number }).count
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200)
  const offset = Math.max(input.offset ?? 0, 0)
  const rows = db.prepare(`
    SELECT * FROM supervision_goals
    WHERE ${where}
    ORDER BY updated_at DESC, created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as SupervisionGoalRow[]
  return { goals: rows.map(view), total }
}

export function updateSupervisionGoal(
  input: UpdateSupervisionGoalInput,
  database?: Database.Database,
): SupervisionGoalView {
  const db = dbOr(database)
  const current = getSupervisionGoal(input.goalId, input.workspaceId, db)
  if (!current) throw new Error('Goal not found')
  if (current.version !== input.expectedVersion) throw new Error('GOAL_STATE_CONFLICT')
  if (['completed', 'failed', 'cancelled'].includes(current.status)) {
    throw new Error('Terminal goal cannot be updated')
  }
  const fields: string[] = []
  const params: Array<string | number | null> = []
  const add = (field: string, value: string | number | null) => {
    fields.push(`${field} = ?`)
    params.push(value)
  }
  if (input.title !== undefined) add('title', input.title.trim())
  if (input.objective !== undefined) add('objective', input.objective.trim())
  if (input.successCriteria !== undefined) add('success_criteria_json', JSON.stringify(input.successCriteria))
  if (input.constraints !== undefined) add('constraints_json', JSON.stringify(input.constraints))
  if (input.allowedWorkerIds !== undefined) add('allowed_workers_json', JSON.stringify(input.allowedWorkerIds))
  if (input.priority !== undefined) add('priority', input.priority)
  if (input.budget !== undefined) add('budget_json', JSON.stringify(input.budget))
  if (input.deadlineAt !== undefined) add('deadline_at', input.deadlineAt)
  if (input.requiresPlanApproval !== undefined) add('requires_plan_approval', input.requiresPlanApproval ? 1 : 0)
  if (fields.length === 0) return current
  const now = Math.floor(Date.now() / 1000)
  db.transaction(() => {
    const result = db.prepare(`
      UPDATE supervision_goals
      SET ${fields.join(', ')}, version = version + 1, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND version = ?
    `).run(...params, now, input.goalId, input.workspaceId, input.expectedVersion)
    if (result.changes !== 1) throw new Error('GOAL_STATE_CONFLICT')
    insertEvent(db, {
      workspaceId: current.workspace_id,
      tenantId: current.tenant_id,
      goalId: current.id,
      eventType: 'goal_updated',
      actorType: 'human_user',
      actorId: input.actorId,
      action: { fields: fields.map((field) => field.split(' ')[0]) },
    })
  })()
  const updated = getSupervisionGoal(input.goalId, input.workspaceId, db)
  if (!updated) throw new Error('Goal not found after update')
  return updated
}

export function applySupervisionGoalAction(input: {
  goalId: string
  workspaceId: number
  expectedVersion: number
  action: SupervisionGoalAction
  actorId: string
  reason?: string | null
  planVersion?: number | null
}, database?: Database.Database): SupervisionGoalView {
  const db = dbOr(database)
  const current = getSupervisionGoal(input.goalId, input.workspaceId, db)
  if (!current) throw new Error('Goal not found')
  if (current.version !== input.expectedVersion) throw new Error('GOAL_STATE_CONFLICT')
  const target = ACTION_TARGETS[input.action][current.status]
  if (!target) throw new Error(`Invalid goal transition: ${current.status} -> ${input.action}`)
  const now = Math.floor(Date.now() / 1000)
  const completedAt = target === 'completed' ? now : null
  db.transaction(() => {
    if (input.action === 'approve_plan') {
      const planVersion = input.planVersion ?? current.current_plan_version
      const approved = db.prepare(`
        UPDATE supervision_goal_plans
        SET status = 'approved'
        WHERE goal_id = ? AND version = ? AND status = 'draft'
      `).run(current.id, planVersion)
      if (approved.changes !== 1) throw new Error('Approved plan not found')
      db.prepare(`
        UPDATE supervision_goal_plans
        SET status = 'superseded'
        WHERE goal_id = ? AND version != ? AND status = 'approved'
      `).run(current.id, planVersion)
    } else if (input.action === 'reject_plan') {
      const planVersion = input.planVersion ?? current.current_plan_version
      const rejected = db.prepare(`
        UPDATE supervision_goal_plans
        SET status = 'rejected'
        WHERE goal_id = ? AND version = ? AND status = 'draft'
      `).run(current.id, planVersion)
      if (rejected.changes !== 1) throw new Error('Plan draft not found')
    }
    const result = db.prepare(`
      UPDATE supervision_goals
      SET status = ?,
          current_plan_version = CASE
            WHEN ? IS NULL THEN current_plan_version
            ELSE ?
          END,
          version = version + 1,
          updated_at = ?,
          completed_at = ?
      WHERE id = ? AND workspace_id = ? AND version = ?
    `).run(
      target,
      input.planVersion ?? null,
      input.planVersion ?? null,
      now,
      completedAt,
      input.goalId,
      input.workspaceId,
      input.expectedVersion,
    )
    if (result.changes !== 1) throw new Error('GOAL_STATE_CONFLICT')
    insertEvent(db, {
      workspaceId: current.workspace_id,
      tenantId: current.tenant_id,
      goalId: current.id,
      eventType: 'goal_status_changed',
      actorType: 'human_user',
      actorId: input.actorId,
      decision: input.action,
      reason: input.reason,
      action: { from_status: current.status, to_status: target, plan_version: input.planVersion ?? null },
      idempotencyKey: `goal:${current.id}:version:${input.expectedVersion}:action:${input.action}`,
    })
  })()
  const updated = getSupervisionGoal(input.goalId, input.workspaceId, db)
  if (!updated) throw new Error('Goal not found after action')
  return updated
}

export function listSupervisionGoalEvents(
  goalId: string,
  workspaceId: number,
  database?: Database.Database,
) {
  return dbOr(database).prepare(`
    SELECT * FROM supervision_events
    WHERE goal_id = ? AND workspace_id = ?
    ORDER BY id ASC
  `).all(goalId, workspaceId) as Array<Record<string, unknown>>
}

export function listSupervisionGoalTasks(
  goalId: string,
  workspaceId: number,
  database?: Database.Database,
) {
  return dbOr(database).prepare(`
    SELECT sgt.goal_id, sgt.task_id, sgt.plan_version, sgt.logical_task_key,
           sgt.dependencies_json, sgt.acceptance_criteria_json,
           sgt.assigned_agent_id, sgt.assigned_session_id, sgt.retry_count,
           sgt.reassignment_count, t.title, t.description, t.status,
           t.priority, t.assigned_to, t.outcome, t.resolution,
           t.error_message, t.metadata, t.updated_at,
           g.client_id,
           COALESCE(
             json_extract(t.metadata, '$.session_kind'),
             CASE lower(COALESCE(sai.framework, ''))
               WHEN 'codex' THEN 'codex-cli'
               WHEN 'codex-cli' THEN 'codex-cli'
               WHEN 'claude' THEN 'claude-code'
               WHEN 'claude-code' THEN 'claude-code'
               WHEN 'hermes' THEN 'hermes'
               ELSE NULL
             END
           ) AS session_kind
    FROM supervision_goal_tasks sgt
    JOIN tasks t ON t.id = sgt.task_id AND t.workspace_id = ?
    JOIN supervision_goals g ON g.id = sgt.goal_id AND g.workspace_id = t.workspace_id
    LEFT JOIN sync_agent_index sai
      ON sai.client_id = g.client_id
     AND CAST(sai.local_agent_id AS TEXT) = sgt.assigned_agent_id
    WHERE sgt.goal_id = ?
    ORDER BY sgt.plan_version DESC, t.id ASC
  `).all(workspaceId, goalId) as Array<Record<string, unknown>>
}
