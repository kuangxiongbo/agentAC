import type Database from 'better-sqlite3'
import { sendEdgeMessageWakeup } from './bridge-server'
import { getDatabase } from './db'
import { createEdgeMessage } from './edge-messages'
import { getSupervisionGoal } from './supervision-goals'
import type { SupervisionGoalPlanRow, SupervisionGoalPlanDraft, SupervisionPlanTask } from './supervision-plans'
import { matchSupervisionWorker } from './supervision-worker-matcher'

interface GoalTaskRow {
  goal_id: string
  task_id: number
  plan_version: number
  logical_task_key: string
  dependencies_json: string
  acceptance_criteria_json: string
  assigned_agent_id: string | null
  assigned_session_id: string | null
  status: string
  outcome: string | null
  assigned_to: string | null
}

export const SUPERVISION_TASK_HOLD_ASSIGNEE = '__supervision_dependency_hold__'
export const SUPERVISION_WORKER_ALLOWED_TOOLS = [
  'Task', 'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write', 'TodoWrite',
] as const
export const SUPERVISION_DEFAULT_TASK_BUDGET_USD = 5

export interface DispatchedSupervisionTask {
  task_id: number
  logical_key: string
  status: string
  assigned_to: string | null
  worker_local_agent_id: number | null
  worker_session_id: string | null
  match_score: number | null
  match_reasons: string[]
  message_id: string | null
  created: boolean
  blocked_reason: string | null
}

export interface DispatchSupervisionGoalResult {
  goal_id: string
  plan_version: number
  tasks: DispatchedSupervisionTask[]
  created_count: number
  activated_count: number
  blocked_count: number
}

interface DispatcherDependencies {
  isClientOnline?: (clientId: string) => boolean
  wakeup?: (clientId: string, detail: Record<string, unknown>) => boolean
}

function getApprovedPlan(db: Database.Database, goalId: string, version: number): SupervisionGoalPlanDraft {
  const row = db.prepare(`
    SELECT * FROM supervision_goal_plans
    WHERE goal_id = ? AND version = ? AND status = 'approved'
    LIMIT 1
  `).get(goalId, version) as SupervisionGoalPlanRow | undefined
  if (!row) throw new Error('Approved plan not found')
  return JSON.parse(row.plan_json) as SupervisionGoalPlanDraft
}

function resolveProject(db: Database.Database, workspaceId: number, requestedProjectId?: number | null) {
  if (requestedProjectId) {
    const requested = db.prepare(`
      SELECT id, ticket_prefix FROM projects
      WHERE id = ? AND workspace_id = ? AND status = 'active'
    `).get(requestedProjectId, workspaceId) as { id: number; ticket_prefix: string } | undefined
    if (requested) return requested
  }
  const fallback = db.prepare(`
    SELECT id, ticket_prefix FROM projects
    WHERE workspace_id = ? AND status = 'active'
    ORDER BY CASE WHEN slug = 'general' THEN 0 ELSE 1 END, id
    LIMIT 1
  `).get(workspaceId) as { id: number; ticket_prefix: string } | undefined
  if (!fallback) throw new Error('No active project available in workspace')
  return fallback
}

function allocateTicket(db: Database.Database, projectId: number, workspaceId: number): number {
  const updated = db.prepare(`
    UPDATE projects SET ticket_counter = ticket_counter + 1, updated_at = unixepoch()
    WHERE id = ? AND workspace_id = ?
  `).run(projectId, workspaceId)
  if (updated.changes !== 1) throw new Error('Failed to allocate project ticket')
  return (db.prepare(`SELECT ticket_counter FROM projects WHERE id = ?`).get(projectId) as { ticket_counter: number }).ticket_counter
}

function priorityForTask(goalPriority: string): string {
  if (goalPriority === 'critical') return 'urgent'
  return goalPriority
}

function dependenciesSatisfied(task: SupervisionPlanTask, taskByKey: Map<string, GoalTaskRow>): boolean {
  return task.dependencies.every((key) => {
    const dependency = taskByKey.get(key)
    return dependency?.status === 'done' && dependency.outcome !== 'failed'
  })
}

function supervisedTaskBudgetUsd(goal: { budget: { max_tasks: number; max_estimated_cost?: number } }): number {
  const total = goal.budget.max_estimated_cost
  if (typeof total === 'number' && Number.isFinite(total)) {
    if (total <= 0) return 0
    return Math.min(SUPERVISION_DEFAULT_TASK_BUDGET_USD, total / Math.max(1, goal.budget.max_tasks))
  }
  return SUPERVISION_DEFAULT_TASK_BUDGET_USD
}

function buildWorkerPrompt(input: {
  goalId: string
  goalTitle: string
  goalObjective: string
  taskId: number
  task: SupervisionPlanTask
  constraints: string[]
}): string {
  return `你是执行 Worker。请完成平台目标任务 #${input.taskId}。

Goal ID：${input.goalId}
目标：${input.goalTitle}
目标描述：${input.goalObjective}
当前任务：${input.task.title}
任务说明：${input.task.description}
约束：${JSON.stringify(input.constraints)}
验收标准：${JSON.stringify(input.task.acceptance_criteria)}

中心 Goal/Task/事件不保存在 Edge 本机 SQLite。开始执行前必须调用 MCP 工具 mc_get_supervision_goal，使用 Goal ID 查询权威任务、依赖和事件状态；不得用本机 tasks 表为空推断中心任务不存在。完成当前任务后必须调用 MCP 工具 mc_complete_supervision_task，提交 outcome、完整 resolution 和结构化 evidence。只有该工具返回 ok=true 才算任务完成，后继任务将由 supervision monitor 自动激活。

请基于当前会话上下文执行。需要用户确认或权限时明确提出问题并等待值守；不要只回复“已完成”。`
}

function insertEvent(db: Database.Database, input: {
  workspaceId: number
  tenantId: number | null
  goalId: string
  taskId: number
  eventType: string
  decision: string
  reason?: string | null
  action: Record<string, unknown>
  messageId?: string | null
  idempotencyKey: string
}) {
  db.prepare(`
    INSERT OR IGNORE INTO supervision_events (
      workspace_id, tenant_id, goal_id, task_id, event_type, actor_type,
      actor_id, decision, reason, action_json, message_id, idempotency_key
    ) VALUES (?, ?, ?, ?, ?, 'system', 'dispatcher', ?, ?, ?, ?, ?)
  `).run(
    input.workspaceId,
    input.tenantId,
    input.goalId,
    input.taskId,
    input.eventType,
    input.decision,
    input.reason ?? null,
    JSON.stringify(input.action),
    input.messageId ?? null,
    input.idempotencyKey,
  )
}

function listGoalTasks(db: Database.Database, goalId: string, planVersion: number): GoalTaskRow[] {
  return db.prepare(`
    SELECT sgt.*, t.status, t.outcome, t.assigned_to
    FROM supervision_goal_tasks sgt
    JOIN tasks t ON t.id = sgt.task_id
    WHERE sgt.goal_id = ? AND sgt.plan_version = ?
  `).all(goalId, planVersion) as GoalTaskRow[]
}

export function dispatchSupervisionGoal(
  input: { goalId: string; workspaceId: number; projectId?: number | null },
  dependencies: DispatcherDependencies = {},
  database?: Database.Database,
): DispatchSupervisionGoalResult {
  const db = database ?? getDatabase()
  const goal = getSupervisionGoal(input.goalId, input.workspaceId, db)
  if (!goal) throw new Error('Goal not found')
  if (goal.status !== 'running') throw new Error(`Invalid goal state for dispatch: ${goal.status}`)
  if (goal.current_plan_version < 1) throw new Error('Goal has no current plan')
  const plan = getApprovedPlan(db, goal.id, goal.current_plan_version)
  const taskBudgetUsd = supervisedTaskBudgetUsd(goal)
  const project = resolveProject(db, goal.workspace_id, input.projectId)
  const wakeups: Array<{ clientId: string; messageId: string; type: string }> = []

  const result = db.transaction(() => {
    let goalTasks = listGoalTasks(db, goal.id, goal.current_plan_version)
    const taskByKey = new Map(goalTasks.map((task) => [task.logical_task_key, task]))
    let activeCount = goalTasks.filter((task) => ['assigned', 'in_progress'].includes(task.status)).length
    const results: DispatchedSupervisionTask[] = []

    for (const planTask of plan.tasks) {
      let relation = taskByKey.get(planTask.logical_key)
      const created = !relation
      let taskId: number
      if (!relation) {
        const ticketNo = allocateTicket(db, project.id, goal.workspace_id)
        const inserted = db.prepare(`
          INSERT INTO tasks (
            title, description, status, priority, project_id, project_ticket_no,
            assigned_to, created_by, created_at, updated_at, estimated_hours,
            tags, metadata, workspace_id
          ) VALUES (?, ?, 'inbox', ?, ?, ?, NULL, 'goal-supervisor', unixepoch(), unixepoch(), ?, ?, ?, ?)
        `).run(
          planTask.title,
          planTask.description,
          priorityForTask(goal.priority),
          project.id,
          ticketNo,
          planTask.estimated_minutes ? Math.max(1, Math.ceil(planTask.estimated_minutes / 60)) : null,
          JSON.stringify(['supervised-goal', `goal:${goal.id}`]),
          JSON.stringify({
            goal_id: goal.id,
            goal_plan_version: goal.current_plan_version,
            logical_task_key: planTask.logical_key,
            dependencies: planTask.dependencies,
            acceptance_criteria: planTask.acceptance_criteria,
            risk: planTask.risk,
            dispatch_allowed_tools: SUPERVISION_WORKER_ALLOWED_TOOLS,
            dispatch_max_budget_usd: taskBudgetUsd,
            dispatch_cwd: '.',
          }),
          goal.workspace_id,
        )
        taskId = Number(inserted.lastInsertRowid)
        db.prepare(`
          INSERT INTO supervision_goal_tasks (
            goal_id, task_id, plan_version, logical_task_key,
            dependencies_json, acceptance_criteria_json
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          goal.id,
          taskId,
          goal.current_plan_version,
          planTask.logical_key,
          JSON.stringify(planTask.dependencies),
          JSON.stringify(planTask.acceptance_criteria),
        )
        relation = {
          goal_id: goal.id,
          task_id: taskId,
          plan_version: goal.current_plan_version,
          logical_task_key: planTask.logical_key,
          dependencies_json: JSON.stringify(planTask.dependencies),
          acceptance_criteria_json: JSON.stringify(planTask.acceptance_criteria),
          assigned_agent_id: null,
          assigned_session_id: null,
          status: 'inbox',
          outcome: null,
          assigned_to: null,
        }
        taskByKey.set(planTask.logical_key, relation)
        insertEvent(db, {
          workspaceId: goal.workspace_id,
          tenantId: goal.tenant_id,
          goalId: goal.id,
          taskId,
          eventType: 'goal_task_created',
          decision: 'created',
          action: { logical_key: planTask.logical_key, plan_version: goal.current_plan_version },
          idempotencyKey: `goal:${goal.id}:plan:${goal.current_plan_version}:task:${planTask.logical_key}:created`,
        })
      } else {
        taskId = relation.task_id
      }

      if (relation.status === 'inbox' && relation.assigned_to === SUPERVISION_TASK_HOLD_ASSIGNEE) {
        db.prepare(`
          UPDATE tasks SET assigned_to = NULL, updated_at = unixepoch()
          WHERE id = ? AND status = 'inbox' AND assigned_to = ?
        `).run(taskId, SUPERVISION_TASK_HOLD_ASSIGNEE)
        relation.assigned_to = null
      }

      if (relation.status !== 'inbox' || relation.assigned_to) {
        results.push({
          task_id: taskId,
          logical_key: planTask.logical_key,
          status: relation.status,
          assigned_to: relation.assigned_to,
          worker_local_agent_id: relation.assigned_agent_id ? Number(relation.assigned_agent_id) : null,
          worker_session_id: relation.assigned_session_id,
          match_score: null,
          match_reasons: [],
          message_id: null,
          created,
          blocked_reason: null,
        })
        continue
      }

      let blockedReason: string | null = null
      if (!dependenciesSatisfied(planTask, taskByKey)) blockedReason = 'dependencies_not_completed'
      else if (activeCount >= goal.budget.max_parallel_workers) blockedReason = 'parallel_worker_budget_reached'
      else if (taskBudgetUsd <= 0) blockedReason = 'estimated_cost_budget_exhausted'

      const match = blockedReason ? null : matchSupervisionWorker({
        goalId: goal.id,
        workspaceId: goal.workspace_id,
        task: planTask,
        maxActiveTasks: 3,
        projectId: project.id,
      }, { isClientOnline: dependencies.isClientOnline }, db)
      if (!blockedReason && !match?.selected) blockedReason = 'no_eligible_worker'

      if (blockedReason || !match?.selected) {
        db.prepare(`
          UPDATE tasks SET assigned_to = ?, updated_at = unixepoch()
          WHERE id = ? AND status = 'inbox' AND assigned_to IS NULL
        `).run(SUPERVISION_TASK_HOLD_ASSIGNEE, taskId)
        relation.assigned_to = SUPERVISION_TASK_HOLD_ASSIGNEE
        const matchDiagnostics = match
          ? {
              candidate_count: match.candidates.length,
              rejected: match.rejected,
            }
          : undefined
        insertEvent(db, {
          workspaceId: goal.workspace_id,
          tenantId: goal.tenant_id,
          goalId: goal.id,
          taskId,
          eventType: 'goal_task_dispatch_blocked',
          decision: 'blocked',
          reason: blockedReason,
          action: {
            logical_key: planTask.logical_key,
            ...(matchDiagnostics ? { match_diagnostics: matchDiagnostics } : {}),
          },
          idempotencyKey: `goal:${goal.id}:plan:${goal.current_plan_version}:task:${planTask.logical_key}:blocked:${blockedReason}`,
        })
        results.push({
          task_id: taskId,
          logical_key: planTask.logical_key,
          status: 'inbox',
          assigned_to: null,
          worker_local_agent_id: null,
          worker_session_id: null,
          match_score: null,
          match_reasons: [],
          message_id: null,
          created,
          blocked_reason: blockedReason,
        })
        continue
      }

      const worker = match.selected
      const prompt = buildWorkerPrompt({
        goalId: goal.id,
        goalTitle: goal.title,
        goalObjective: goal.objective,
        taskId,
        task: planTask,
        constraints: goal.constraints,
      })
      const message = createEdgeMessage({
        workspaceId: goal.workspace_id,
        tenantId: goal.tenant_id,
        clientId: worker.client_id,
        type: 'session.continue.requested',
        direction: 'cloud_to_edge',
        correlationId: `goal:${goal.id}:task:${taskId}`,
        idempotencyKey: `goal:${goal.id}:plan:${goal.current_plan_version}:task:${planTask.logical_key}:dispatch`,
        agentRef: {
          local_agent_id: worker.local_agent_id,
          agent_name: worker.name,
          framework: worker.framework,
        },
        sessionRef: {
          session_id: worker.session_id,
          session_kind: worker.framework,
          serial_key: `${worker.client_id}:${worker.framework}:${worker.session_id}`,
        },
        payload: {
          session_id: worker.session_id,
          session_kind: worker.framework,
          worker_local_agent_id: worker.local_agent_id,
          content: prompt,
          goal_id: goal.id,
          task_id: taskId,
          logical_task_key: planTask.logical_key,
          dispatch_allowed_tools: SUPERVISION_WORKER_ALLOWED_TOOLS,
          dispatch_max_budget_usd: taskBudgetUsd,
          dispatch_cwd: '.',
        },
      }, db)
      db.prepare(`
        UPDATE tasks SET status = 'in_progress', assigned_to = ?, metadata = json_set(
          COALESCE(metadata, '{}'),
          '$.target_session', ?,
          '$.worker_local_agent_id', ?,
          '$.worker_client_id', ?,
          '$.worker_match_score', ?
        ), updated_at = unixepoch()
        WHERE id = ? AND status = 'inbox'
      `).run(
        worker.assignment_name,
        worker.session_id,
        worker.local_agent_id,
        worker.client_id,
        worker.score,
        taskId,
      )
      db.prepare(`
        UPDATE supervision_goal_tasks
        SET assigned_agent_id = ?, assigned_session_id = ?, updated_at = unixepoch()
        WHERE goal_id = ? AND task_id = ?
      `).run(String(worker.local_agent_id), worker.session_id, goal.id, taskId)
      relation.status = 'in_progress'
      relation.assigned_to = worker.assignment_name
      relation.assigned_agent_id = String(worker.local_agent_id)
      relation.assigned_session_id = worker.session_id
      activeCount++
      insertEvent(db, {
        workspaceId: goal.workspace_id,
        tenantId: goal.tenant_id,
        goalId: goal.id,
        taskId,
        eventType: 'goal_task_dispatched',
        decision: 'assigned',
        action: {
          logical_key: planTask.logical_key,
          worker_local_agent_id: worker.local_agent_id,
          worker_name: worker.name,
          client_id: worker.client_id,
          session_id: worker.session_id,
          match_score: worker.score,
          match_reasons: worker.reasons,
        },
        messageId: message.message.id,
        idempotencyKey: `goal:${goal.id}:plan:${goal.current_plan_version}:task:${planTask.logical_key}:dispatched`,
      })
      if (message.created) wakeups.push({ clientId: worker.client_id, messageId: message.message.id, type: message.message.type })
      results.push({
        task_id: taskId,
        logical_key: planTask.logical_key,
        status: 'in_progress',
        assigned_to: worker.assignment_name,
        worker_local_agent_id: worker.local_agent_id,
        worker_session_id: worker.session_id,
        match_score: worker.score,
        match_reasons: worker.reasons,
        message_id: message.message.id,
        created,
        blocked_reason: null,
      })
    }

    goalTasks = listGoalTasks(db, goal.id, goal.current_plan_version)
    return {
      goal_id: goal.id,
      plan_version: goal.current_plan_version,
      tasks: results,
      created_count: results.filter((task) => task.created).length,
      activated_count: results.filter((task) => task.status === 'in_progress' && task.message_id).length,
      blocked_count: goalTasks.filter((task) => task.status === 'inbox').length,
    }
  })()

  const wakeup = dependencies.wakeup ?? sendEdgeMessageWakeup
  for (const item of wakeups) {
    wakeup(item.clientId, { message_id: item.messageId, type: item.type, goal_id: goal.id })
  }
  return result
}
