import type Database from 'better-sqlite3'
import { sendEdgeMessageWakeup } from './bridge-server'
import { getDatabase } from './db'
import { createEdgeMessage } from './edge-messages'
import { getSupervisionGoal } from './supervision-goals'
import type { SupervisionGoalPlanDraft, SupervisionGoalPlanRow, SupervisionPlanTask } from './supervision-plans'
import { matchSupervisionWorker, type SupervisionWorkerCandidate } from './supervision-worker-matcher'

export type SupervisionCorrectionAction =
  | 'request_progress'
  | 'correct_direction'
  | 'retry_task'
  | 'reassign_task'
  | 'request_replan'
  | 'escalate_human'

interface GoalTaskContext {
  task_id: number
  logical_task_key: string
  assigned_agent_id: string | null
  assigned_session_id: string | null
  retry_count: number
  reassignment_count: number
  title: string
  description: string | null
  status: string
  assigned_to: string | null
  metadata: string | null
}

interface CorrectionDependencies {
  isClientOnline?: (clientId: string) => boolean
  wakeup?: (clientId: string, detail: Record<string, unknown>) => boolean
}

export interface SupervisionCorrectionResult {
  goal_id: string
  task_id: number | null
  action: SupervisionCorrectionAction
  applied: boolean
  message_id: string | null
  reason: string
}

function dbOr(database?: Database.Database) {
  return database ?? getDatabase()
}

function planTaskFor(db: Database.Database, goalId: string, version: number, logicalKey: string): SupervisionPlanTask {
  const row = db.prepare(`
    SELECT * FROM supervision_goal_plans
    WHERE goal_id = ? AND version = ? LIMIT 1
  `).get(goalId, version) as SupervisionGoalPlanRow | undefined
  if (!row) throw new Error('Goal plan not found')
  const plan = JSON.parse(row.plan_json) as SupervisionGoalPlanDraft
  const task = plan.tasks.find((item) => item.logical_key === logicalKey)
  if (!task) throw new Error('Plan task not found')
  return task
}

function taskContext(db: Database.Database, goalId: string, taskId: number): GoalTaskContext {
  const row = db.prepare(`
    SELECT sgt.task_id, sgt.logical_task_key, sgt.assigned_agent_id,
           sgt.assigned_session_id, sgt.retry_count, sgt.reassignment_count,
           t.title, t.description, t.status, t.assigned_to, t.metadata
    FROM supervision_goal_tasks sgt
    JOIN tasks t ON t.id = sgt.task_id
    WHERE sgt.goal_id = ? AND sgt.task_id = ?
    LIMIT 1
  `).get(goalId, taskId) as GoalTaskContext | undefined
  if (!row) throw new Error('Goal task not found')
  return row
}

function workerFromCurrentAssignment(
  db: Database.Database,
  clientId: string,
  task: GoalTaskContext,
): SupervisionWorkerCandidate {
  if (!task.assigned_agent_id || !task.assigned_session_id) throw new Error('Task has no assigned worker session')
  const row = db.prepare(`
    SELECT client_id, client_name, local_agent_id, original_name, remote_name,
           role, status, framework, session_key
    FROM sync_agent_index
    WHERE client_id = ? AND local_agent_id = ?
    LIMIT 1
  `).get(clientId, Number(task.assigned_agent_id)) as {
    client_id: string
    client_name: string
    local_agent_id: number
    original_name: string
    remote_name: string
    role: string
    status: string
    framework: string
    session_key: string | null
  } | undefined
  if (!row) throw new Error('Assigned worker is missing')
  const framework = ['claude', 'claude-sdk'].includes(row.framework) ? 'claude-code'
    : ['codex', 'openai'].includes(row.framework) ? 'codex-cli'
      : row.framework
  if (!['claude-code', 'codex-cli', 'hermes'].includes(framework)) throw new Error('Assigned worker framework is unsupported')
  return {
    agent_id: null,
    local_agent_id: row.local_agent_id,
    client_id: row.client_id,
    client_name: row.client_name,
    name: row.original_name,
    assignment_name: task.assigned_to || row.remote_name,
    role: row.role,
    framework: framework as SupervisionWorkerCandidate['framework'],
    session_id: task.assigned_session_id,
    status: row.status,
    capabilities: [],
    active_tasks: 0,
    recent_success_rate: null,
    score: 0,
    reasons: ['existing assignment'],
  }
}

function correctionPrompt(action: SupervisionCorrectionAction, task: GoalTaskContext, instruction: string): string {
  const command = action === 'request_progress'
    ? '请汇报当前进度、已完成内容、阻塞点和下一步，并继续执行可安全推进的部分。'
    : action === 'correct_direction'
      ? '当前输出可能偏离目标。请停止偏离方向，按下面纠偏要求重新检查并继续。'
      : '请重新执行当前任务，先复盘上次失败原因，避免重复同一错误。'
  return `目标监督值守对平台任务 #${task.task_id} 发出控制指令。

${command}
纠偏依据：${instruction}
任务：${task.title}
任务说明：${task.description || ''}

需要权限或用户决策时明确提出并等待，不得自行越权；完成后提交可验证证据。`
}

function createWorkerMessage(db: Database.Database, input: {
  workspaceId: number
  tenantId: number | null
  goalId: string
  planVersion: number
  task: GoalTaskContext
  worker: SupervisionWorkerCandidate
  action: SupervisionCorrectionAction
  instruction: string
  sourceEventId?: number | null
}) {
  return createEdgeMessage({
    workspaceId: input.workspaceId,
    tenantId: input.tenantId,
    clientId: input.worker.client_id,
    direction: 'cloud_to_edge',
    type: 'session.continue.requested',
    correlationId: `goal:${input.goalId}:task:${input.task.task_id}`,
    idempotencyKey: input.sourceEventId
      ? `goal:${input.goalId}:event:${input.sourceEventId}:action:${input.action}`
      : `goal:${input.goalId}:task:${input.task.task_id}:action:${input.action}:${input.task.retry_count}:${input.task.reassignment_count}`,
    agentRef: {
      local_agent_id: input.worker.local_agent_id,
      agent_name: input.worker.name,
      framework: input.worker.framework,
    },
    sessionRef: {
      session_id: input.worker.session_id,
      session_kind: input.worker.framework,
      serial_key: `${input.worker.client_id}:${input.worker.framework}:${input.worker.session_id}`,
    },
    payload: {
      session_id: input.worker.session_id,
      session_kind: input.worker.framework,
      content: correctionPrompt(input.action, input.task, input.instruction),
      goal_id: input.goalId,
      task_id: input.task.task_id,
      correction_action: input.action,
      source_event_id: input.sourceEventId ?? null,
    },
  }, db)
}

function recordAction(db: Database.Database, input: {
  workspaceId: number
  tenantId: number | null
  goalId: string
  taskId?: number | null
  action: SupervisionCorrectionAction
  reason: string
  sourceEventId?: number | null
  messageId?: string | null
  detail?: Record<string, unknown>
}) {
  db.prepare(`
    INSERT OR IGNORE INTO supervision_events (
      workspace_id, tenant_id, goal_id, task_id, event_type, actor_type,
      actor_id, decision, reason, evidence_json, action_json, message_id,
      correlation_id, idempotency_key
    ) VALUES (?, ?, ?, ?, 'supervision_correction_applied', 'steward_agent',
      'goal-supervisor', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.workspaceId,
    input.tenantId,
    input.goalId,
    input.taskId ?? null,
    input.action,
    input.reason,
    input.sourceEventId ? JSON.stringify({ source_event_id: input.sourceEventId }) : null,
    JSON.stringify(input.detail ?? {}),
    input.messageId ?? null,
    input.sourceEventId ? `supervision-event:${input.sourceEventId}` : null,
    input.sourceEventId
      ? `goal:${input.goalId}:event:${input.sourceEventId}:correction`
      : `goal:${input.goalId}:task:${input.taskId ?? 0}:manual:${input.action}:${Date.now()}`,
  )
}

export function applySupervisionCorrection(
  input: {
    goalId: string
    workspaceId: number
    taskId?: number | null
    action: SupervisionCorrectionAction
    reason: string
    instruction?: string | null
    sourceEventId?: number | null
  },
  dependencies: CorrectionDependencies = {},
  database?: Database.Database,
): SupervisionCorrectionResult {
  const db = dbOr(database)
  const goal = getSupervisionGoal(input.goalId, input.workspaceId, db)
  if (!goal) throw new Error('Goal not found')
  if (!['running', 'blocked', 'verifying'].includes(goal.status)) {
    throw new Error(`Invalid goal state for correction: ${goal.status}`)
  }
  const wakeups: Array<{ clientId: string; messageId: string; type: string }> = []

  const result = db.transaction((): SupervisionCorrectionResult => {
    if (input.sourceEventId) {
      const existing = db.prepare(`
        SELECT message_id FROM supervision_events
        WHERE workspace_id = ? AND idempotency_key = ?
      `).get(goal.workspace_id, `goal:${goal.id}:event:${input.sourceEventId}:correction`) as { message_id: string | null } | undefined
      if (existing) return {
        goal_id: goal.id,
        task_id: input.taskId ?? null,
        action: input.action,
        applied: false,
        message_id: existing.message_id,
        reason: 'already_applied',
      }
    }

    if (input.action === 'request_replan') {
      const usage = { ...goal.usage }
      const replans = Number(usage.replans || 0)
      if (replans >= goal.budget.max_replans) throw new Error('GOAL_REPLAN_BUDGET_EXCEEDED')
      usage.replans = replans + 1
      db.prepare(`
        UPDATE supervision_goals
        SET status = 'planning', usage_json = ?, version = version + 1, updated_at = unixepoch()
        WHERE id = ? AND workspace_id = ?
      `).run(JSON.stringify(usage), goal.id, goal.workspace_id)
      recordAction(db, {
        workspaceId: goal.workspace_id,
        tenantId: goal.tenant_id,
        goalId: goal.id,
        action: input.action,
        reason: input.reason,
        sourceEventId: input.sourceEventId,
        detail: { replan_count: replans + 1 },
      })
      return { goal_id: goal.id, task_id: null, action: input.action, applied: true, message_id: null, reason: input.reason }
    }

    if (input.action === 'escalate_human') {
      db.prepare(`
        UPDATE supervision_goals
        SET status = 'blocked', version = version + 1, updated_at = unixepoch()
        WHERE id = ? AND workspace_id = ? AND status != 'blocked'
      `).run(goal.id, goal.workspace_id)
      recordAction(db, {
        workspaceId: goal.workspace_id,
        tenantId: goal.tenant_id,
        goalId: goal.id,
        taskId: input.taskId,
        action: input.action,
        reason: input.reason,
        sourceEventId: input.sourceEventId,
        detail: { human_required: true },
      })
      return { goal_id: goal.id, task_id: input.taskId ?? null, action: input.action, applied: true, message_id: null, reason: input.reason }
    }

    if (!input.taskId) throw new Error('taskId is required for worker correction')
    const task = taskContext(db, goal.id, input.taskId)
    const planTask = planTaskFor(db, goal.id, goal.current_plan_version, task.logical_task_key)
    let worker: SupervisionWorkerCandidate

    if (input.action === 'reassign_task') {
      if (task.reassignment_count >= goal.budget.max_retries_per_task) {
        throw new Error('GOAL_TASK_REASSIGNMENT_BUDGET_EXCEEDED')
      }
      const match = matchSupervisionWorker({
        goalId: goal.id,
        workspaceId: goal.workspace_id,
        task: planTask,
        excludedWorkerIds: task.assigned_agent_id ? [Number(task.assigned_agent_id)] : [],
      }, { isClientOnline: dependencies.isClientOnline }, db)
      if (!match.selected) throw new Error('NO_REASSIGNMENT_WORKER_AVAILABLE')
      worker = match.selected
      db.prepare(`
        UPDATE supervision_goal_tasks
        SET assigned_agent_id = ?, assigned_session_id = ?,
            reassignment_count = reassignment_count + 1, updated_at = unixepoch()
        WHERE goal_id = ? AND task_id = ?
      `).run(String(worker.local_agent_id), worker.session_id, goal.id, task.task_id)
      db.prepare(`
        UPDATE tasks SET assigned_to = ?, status = 'in_progress', updated_at = unixepoch()
        WHERE id = ?
      `).run(worker.assignment_name, task.task_id)
    } else {
      worker = workerFromCurrentAssignment(db, goal.client_id, task)
      if (input.action === 'retry_task') {
        if (task.retry_count >= goal.budget.max_retries_per_task) {
          throw new Error('GOAL_TASK_RETRY_BUDGET_EXCEEDED')
        }
        db.prepare(`
          UPDATE supervision_goal_tasks
          SET retry_count = retry_count + 1, updated_at = unixepoch()
          WHERE goal_id = ? AND task_id = ?
        `).run(goal.id, task.task_id)
        db.prepare(`UPDATE tasks SET status = 'in_progress', outcome = NULL, error_message = NULL, updated_at = unixepoch() WHERE id = ?`)
          .run(task.task_id)
      }
    }

    const message = createWorkerMessage(db, {
      workspaceId: goal.workspace_id,
      tenantId: goal.tenant_id,
      goalId: goal.id,
      planVersion: goal.current_plan_version,
      task,
      worker,
      action: input.action,
      instruction: input.instruction || input.reason,
      sourceEventId: input.sourceEventId,
    })
    recordAction(db, {
      workspaceId: goal.workspace_id,
      tenantId: goal.tenant_id,
      goalId: goal.id,
      taskId: task.task_id,
      action: input.action,
      reason: input.reason,
      sourceEventId: input.sourceEventId,
      messageId: message.message.id,
      detail: {
        worker_local_agent_id: worker.local_agent_id,
        worker_session_id: worker.session_id,
      },
    })
    if (message.created) wakeups.push({ clientId: worker.client_id, messageId: message.message.id, type: message.message.type })
    return {
      goal_id: goal.id,
      task_id: task.task_id,
      action: input.action,
      applied: true,
      message_id: message.message.id,
      reason: input.reason,
    }
  })()

  const wakeup = dependencies.wakeup ?? sendEdgeMessageWakeup
  for (const item of wakeups) wakeup(item.clientId, { message_id: item.messageId, type: item.type, goal_id: goal.id })
  return result
}

const AUTO_ACTIONS: Record<string, SupervisionCorrectionAction | undefined> = {
  worker_output_deviation_detected: 'correct_direction',
  worker_output_insufficient: 'request_progress',
  task_timeout_detected: 'request_progress',
  worker_offline_detected: 'reassign_task',
  worker_dispatch_failure_detected: 'reassign_task',
}

export function runSupervisionCorrections(
  input: { workspaceId?: number; limit?: number } = {},
  dependencies: CorrectionDependencies = {},
  database?: Database.Database,
): { processed: number; applied: number; escalated: number; errors: string[] } {
  const db = dbOr(database)
  const workspaceId = input.workspaceId ?? 1
  const events = db.prepare(`
    SELECT se.id, se.goal_id, se.task_id, se.event_type, se.reason
    FROM supervision_events se
    JOIN supervision_goals sg ON sg.id = se.goal_id
    WHERE se.workspace_id = ?
      AND sg.status IN ('running', 'blocked', 'verifying')
      AND se.event_type IN (
        'worker_output_deviation_detected', 'worker_output_insufficient',
        'task_timeout_detected', 'worker_offline_detected',
        'worker_dispatch_failure_detected'
      )
      AND NOT EXISTS (
        SELECT 1 FROM supervision_events action
        WHERE action.workspace_id = se.workspace_id
          AND action.idempotency_key = 'goal:' || se.goal_id || ':event:' || se.id || ':correction'
      )
    ORDER BY se.created_at, se.id
    LIMIT ?
  `).all(workspaceId, Math.min(Math.max(input.limit ?? 20, 1), 100)) as Array<{
    id: number
    goal_id: string
    task_id: number | null
    event_type: string
    reason: string | null
  }>
  const result = { processed: 0, applied: 0, escalated: 0, errors: [] as string[] }
  for (const event of events) {
    result.processed++
    const action = AUTO_ACTIONS[event.event_type]
    if (!action || !event.task_id) continue
    try {
      const applied = applySupervisionCorrection({
        goalId: event.goal_id,
        workspaceId,
        taskId: event.task_id,
        action,
        reason: event.reason || event.event_type,
        sourceEventId: event.id,
      }, dependencies, db)
      if (applied.applied) result.applied++
    } catch (error) {
      const message = error instanceof Error ? error.message : 'correction failed'
      result.errors.push(`event=${event.id}: ${message}`)
      try {
        const escalated = applySupervisionCorrection({
          goalId: event.goal_id,
          workspaceId,
          taskId: event.task_id,
          action: 'escalate_human',
          reason: `Automatic ${action} failed: ${message}`,
          sourceEventId: event.id,
        }, dependencies, db)
        if (escalated.applied) result.escalated++
      } catch (escalationError) {
        result.errors.push(`event=${event.id} escalation: ${escalationError instanceof Error ? escalationError.message : 'failed'}`)
      }
    }
  }
  return result
}
