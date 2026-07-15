import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { isBridgeClientOnline, requestBridgeClientStewardJudge, sendEdgeMessageWakeup } from './bridge-server'
import { getDatabase } from './db'
import { dispatchSupervisionGoal } from './supervision-dispatcher'
import { getSupervisionGoal, listSupervisionGoals, type SupervisionGoalView } from './supervision-goals'
import { consumeSupervisionModelCall } from './supervision-budget'
import { searchStewardMemories } from './steward-memory-search'
import { listSyncClients } from './sync-clients'

interface MonitoredTaskRow {
  task_id: number
  logical_task_key: string
  assigned_agent_id: string | null
  assigned_session_id: string | null
  title: string
  description: string | null
  status: string
  outcome: string | null
  resolution: string | null
  error_message: string | null
  estimated_hours: number | null
  created_at: number
  updated_at: number
  assigned_to: string | null
}

interface SemanticDecision {
  decision: 'aligned' | 'deviated' | 'insufficient'
  confidence: number
  reason: string
  suggested_action?: string
}

type JudgeRunner = typeof requestBridgeClientStewardJudge

export interface SupervisionMonitorResult {
  goals_scanned: number
  goals_leased: number
  observations_created: number
  semantic_checks: number
  dispatches_run: number
  tasks_activated: number
  errors: string[]
}

interface MonitorDependencies {
  runJudge?: JudgeRunner
  isClientOnline?: (clientId: string) => boolean
  wakeup?: (clientId: string, detail: Record<string, unknown>) => boolean
}

function dbOr(database?: Database.Database) {
  return database ?? getDatabase()
}

function defaultClientOnline(workspaceId: number): (clientId: string) => boolean {
  const connected = new Set(
    listSyncClients(workspaceId)
      .filter((client) => client.status === 'connected')
      .map((client) => client.client_id),
  )
  return (clientId) => isBridgeClientOnline(clientId) || connected.has(clientId)
}

function insertObservation(db: Database.Database, input: {
  goal: SupervisionGoalView
  taskId?: number | null
  eventType: string
  decision: string
  reason: string
  evidence?: Record<string, unknown>
  action?: Record<string, unknown>
  idempotencyKey: string
}): boolean {
  const result = db.prepare(`
    INSERT OR IGNORE INTO supervision_events (
      workspace_id, tenant_id, goal_id, task_id, event_type, actor_type,
      actor_id, decision, reason, evidence_json, action_json, idempotency_key
    ) VALUES (?, ?, ?, ?, ?, 'system', 'supervision-monitor', ?, ?, ?, ?, ?)
  `).run(
    input.goal.workspace_id,
    input.goal.tenant_id,
    input.goal.id,
    input.taskId ?? null,
    input.eventType,
    input.decision,
    input.reason,
    input.evidence ? JSON.stringify(input.evidence) : null,
    input.action ? JSON.stringify(input.action) : null,
    input.idempotencyKey,
  )
  return result.changes === 1
}

function acquireLease(
  db: Database.Database,
  goalId: string,
  ownerId: string,
  now: number,
  leaseSeconds: number,
): boolean {
  const result = db.prepare(`
    INSERT INTO supervision_leases (goal_id, owner_id, lease_expires_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(goal_id) DO UPDATE SET
      owner_id = excluded.owner_id,
      lease_expires_at = excluded.lease_expires_at,
      updated_at = excluded.updated_at
    WHERE supervision_leases.lease_expires_at <= ?
       OR supervision_leases.owner_id = excluded.owner_id
  `).run(goalId, ownerId, now + leaseSeconds, now, now)
  return result.changes === 1
}

function listTasks(db: Database.Database, goal: SupervisionGoalView): MonitoredTaskRow[] {
  return db.prepare(`
    SELECT sgt.task_id, sgt.logical_task_key, sgt.assigned_agent_id,
           sgt.assigned_session_id, t.title, t.description, t.status, t.outcome,
           t.resolution, t.error_message, t.estimated_hours, t.created_at,
           t.updated_at, t.assigned_to
    FROM supervision_goal_tasks sgt
    JOIN tasks t ON t.id = sgt.task_id
    WHERE sgt.goal_id = ? AND sgt.plan_version = ?
    ORDER BY t.id
  `).all(goal.id, goal.current_plan_version) as MonitoredTaskRow[]
}

function extractJson(raw: string): unknown {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()
  const candidate = fenced || trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1)
  return JSON.parse(candidate)
}

function parseSemanticDecision(raw: string): SemanticDecision {
  const parsed = extractJson(raw) as Partial<SemanticDecision>
  if (!['aligned', 'deviated', 'insufficient'].includes(String(parsed.decision))) {
    throw new Error('SEMANTIC_DECISION_INVALID')
  }
  const confidence = Number(parsed.confidence)
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error('SEMANTIC_CONFIDENCE_INVALID')
  }
  const reason = String(parsed.reason || '').trim()
  if (!reason) throw new Error('SEMANTIC_REASON_REQUIRED')
  return {
    decision: parsed.decision as SemanticDecision['decision'],
    confidence,
    reason,
    suggested_action: typeof parsed.suggested_action === 'string' ? parsed.suggested_action : undefined,
  }
}

function semanticPrompt(goal: SupervisionGoalView, task: MonitoredTaskRow, output: string, memoryContext = ''): string {
  return `你是目标监督值守 Agent。判断 Worker 输出是否偏离目标、任务说明、约束或验收标准。

只输出 JSON：
{"decision":"aligned|deviated|insufficient","confidence":0.0,"reason":"判断依据","suggested_action":"建议动作"}

目标：${goal.title}
目标描述：${goal.objective}
成功标准：${JSON.stringify(goal.success_criteria)}
约束：${JSON.stringify(goal.constraints)}
任务：${task.title}
任务说明：${task.description || ''}
Worker 输出：${output}
${memoryContext ? `\n已批准值守记忆（仅作参考，当前证据和安全策略优先）：\n${memoryContext}` : ''}`
}

function deterministicObservations(
  db: Database.Database,
  goal: SupervisionGoalView,
  tasks: MonitoredTaskRow[],
  now: number,
  isClientOnline: (clientId: string) => boolean,
): number {
  let created = 0
  for (const task of tasks) {
    if (task.assigned_agent_id && ['assigned', 'in_progress'].includes(task.status)) {
      const worker = db.prepare(`
        SELECT status, updated_at FROM sync_agent_index
        WHERE client_id = ? AND local_agent_id = ?
        LIMIT 1
      `).get(goal.client_id, Number(task.assigned_agent_id)) as { status: string; updated_at: number } | undefined
      const clientOnline = isClientOnline(goal.client_id)
      if (!clientOnline && (!worker || ['offline', 'error', 'sleeping'].includes(worker.status) || now - worker.updated_at > 300)) {
        if (insertObservation(db, {
          goal,
          taskId: task.task_id,
          eventType: 'worker_offline_detected',
          decision: 'needs_correction',
          reason: worker ? `Worker status is ${worker.status}` : 'Worker is missing from edge index',
          evidence: { assigned_agent_id: task.assigned_agent_id, worker: worker ?? null },
          idempotencyKey: `goal:${goal.id}:task:${task.task_id}:worker-offline:${worker?.updated_at ?? 0}`,
        })) created++
      }
    }

    const failedMessage = db.prepare(`
      SELECT id, status, last_error_code, last_error_message, updated_at
      FROM edge_messages
      WHERE correlation_id = ? AND status IN ('dead_letter', 'failed_retryable')
      ORDER BY updated_at DESC LIMIT 1
    `).get(`goal:${goal.id}:task:${task.task_id}`) as {
      id: string
      status: string
      last_error_code: string | null
      last_error_message: string | null
      updated_at: number
    } | undefined
    if (failedMessage && insertObservation(db, {
      goal,
      taskId: task.task_id,
      eventType: 'worker_dispatch_failure_detected',
      decision: 'needs_correction',
      reason: failedMessage.last_error_message || failedMessage.status,
      evidence: failedMessage,
      idempotencyKey: `goal:${goal.id}:task:${task.task_id}:message-failed:${failedMessage.id}:${failedMessage.updated_at}`,
    })) created++

    if (task.assigned_session_id) {
      const permission = db.prepare(`
        SELECT id, request_type, risk, created_at
        FROM permission_requests
        WHERE workspace_id = ? AND worker_session_id = ? AND status = 'pending'
        ORDER BY created_at DESC LIMIT 1
      `).get(goal.workspace_id, task.assigned_session_id) as {
        id: string
        request_type: string
        risk: string
        created_at: number
      } | undefined
      if (permission && insertObservation(db, {
        goal,
        taskId: task.task_id,
        eventType: 'worker_waiting_permission_detected',
        decision: 'awaiting_decision',
        reason: `Worker is waiting for ${permission.request_type}`,
        evidence: permission,
        idempotencyKey: `goal:${goal.id}:task:${task.task_id}:permission:${permission.id}`,
      })) created++
    }

    if (task.status === 'in_progress') {
      const expectedSeconds = Math.max(30 * 60, (task.estimated_hours ?? 1) * 2 * 3600)
      if (now - task.updated_at > expectedSeconds && insertObservation(db, {
        goal,
        taskId: task.task_id,
        eventType: 'task_timeout_detected',
        decision: 'needs_progress_check',
        reason: `Task has not changed for ${now - task.updated_at} seconds`,
        evidence: { expected_seconds: expectedSeconds, updated_at: task.updated_at, now },
        idempotencyKey: `goal:${goal.id}:task:${task.task_id}:timeout:${task.updated_at}`,
      })) created++
    }

    if (task.status === 'done' && insertObservation(db, {
      goal,
      taskId: task.task_id,
      eventType: 'task_completion_observed',
      decision: 'ready_for_verification',
      reason: 'Worker task reached done state',
      evidence: { outcome: task.outcome, resolution: task.resolution },
      idempotencyKey: `goal:${goal.id}:task:${task.task_id}:completed:${task.updated_at}`,
    })) created++
  }

  if (tasks.length > 0 && tasks.every((task) => task.status === 'done') && goal.status === 'running') {
    const updated = db.prepare(`
      UPDATE supervision_goals
      SET status = 'verifying', version = version + 1, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND status = 'running'
    `).run(now, goal.id, goal.workspace_id)
    if (updated.changes === 1 && insertObservation(db, {
      goal,
      eventType: 'goal_verification_started',
      decision: 'verifying',
      reason: 'All current plan tasks are done',
      evidence: { task_ids: tasks.map((task) => task.task_id), plan_version: goal.current_plan_version },
      idempotencyKey: `goal:${goal.id}:plan:${goal.current_plan_version}:verification-started`,
    })) created++
  }
  return created
}

async function semanticObservations(
  db: Database.Database,
  goal: SupervisionGoalView,
  tasks: MonitoredTaskRow[],
  runJudge: JudgeRunner,
): Promise<{ created: number; checks: number; errors: string[] }> {
  let created = 0
  let checks = 0
  const errors: string[] = []
  for (const task of tasks) {
    if (!['review', 'done'].includes(task.status)) continue
    const latestComment = db.prepare(`
      SELECT content FROM comments WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(task.task_id) as { content: string } | undefined
    const output = String(task.resolution || latestComment?.content || '').trim()
    if (!output) continue
    const idempotencyKey = `goal:${goal.id}:task:${task.task_id}:semantic:${task.updated_at}`
    const existing = db.prepare(`
      SELECT 1 FROM supervision_events WHERE workspace_id = ? AND idempotency_key = ?
    `).get(goal.workspace_id, idempotencyKey)
    if (existing) continue
    checks++
    try {
      const memory = searchStewardMemories({
        workspaceId: goal.workspace_id,
        tenantId: goal.tenant_id,
        goalId: goal.id,
        query: `${task.title} ${task.description || ''} ${output}`,
        limit: 4,
        maxChars: 1200,
      }, db)
      consumeSupervisionModelCall({ goalId: goal.id, workspaceId: goal.workspace_id }, db)
      const result = await runJudge({
        clientId: goal.client_id,
        localAgentId: goal.steward_local_agent_id,
        prompt: semanticPrompt(goal, task, output, memory.context),
        timeoutMs: 300_000,
      })
      const decision = parseSemanticDecision(result.reply)
      const eventType = decision.decision === 'deviated'
        ? 'worker_output_deviation_detected'
        : decision.decision === 'aligned'
          ? 'worker_output_aligned'
          : 'worker_output_insufficient'
      if (insertObservation(db, {
        goal,
        taskId: task.task_id,
        eventType,
        decision: decision.decision,
        reason: decision.reason,
        evidence: { output, confidence: decision.confidence },
        action: decision.suggested_action ? { suggested_action: decision.suggested_action } : undefined,
        idempotencyKey,
      })) created++
    } catch (error) {
      const message = error instanceof Error ? error.message : 'semantic judge failed'
      errors.push(`goal=${goal.id} task=${task.task_id}: ${message}`)
      if (insertObservation(db, {
        goal,
        taskId: task.task_id,
        eventType: 'semantic_check_failed',
        decision: 'error',
        reason: message,
        idempotencyKey,
      })) created++
    }
  }
  return { created, checks, errors }
}

export async function runSupervisionMonitor(
  input: { workspaceId?: number; ownerId?: string; nowSeconds?: number; leaseSeconds?: number } = {},
  dependencies: MonitorDependencies = {},
  database?: Database.Database,
): Promise<SupervisionMonitorResult> {
  const db = dbOr(database)
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000)
  const ownerId = input.ownerId ?? `supervision-monitor:${process.pid}:${randomUUID()}`
  const goals = listSupervisionGoals({
    workspaceId: input.workspaceId ?? 1,
    status: 'running',
    limit: 200,
  }, db).goals
  const result: SupervisionMonitorResult = {
    goals_scanned: goals.length,
    goals_leased: 0,
    observations_created: 0,
    semantic_checks: 0,
    dispatches_run: 0,
    tasks_activated: 0,
    errors: [],
  }
  const runJudge = dependencies.runJudge ?? requestBridgeClientStewardJudge
  const isClientOnline = dependencies.isClientOnline ?? defaultClientOnline(input.workspaceId ?? 1)
  const wakeup = dependencies.wakeup ?? sendEdgeMessageWakeup
  for (const listedGoal of goals) {
    if (!acquireLease(db, listedGoal.id, ownerId, now, input.leaseSeconds ?? 55)) continue
    result.goals_leased++
    const goal = getSupervisionGoal(listedGoal.id, listedGoal.workspace_id, db)
    if (!goal || goal.status !== 'running') continue
    const tasks = listTasks(db, goal)
    result.observations_created += deterministicObservations(db, goal, tasks, now, isClientOnline)
    const current = getSupervisionGoal(goal.id, goal.workspace_id, db)
    if (current?.status === 'running') {
      try {
        const dispatched = dispatchSupervisionGoal({
          goalId: goal.id,
          workspaceId: goal.workspace_id,
        }, { isClientOnline, wakeup }, db)
        result.dispatches_run++
        result.tasks_activated += dispatched.activated_count
      } catch (error) {
        result.errors.push(`goal=${goal.id}: ${error instanceof Error ? error.message : 'dispatcher failed'}`)
      }
    }
    const semantic = await semanticObservations(db, goal, tasks, runJudge)
    result.observations_created += semantic.created
    result.semantic_checks += semantic.checks
    result.errors.push(...semantic.errors)
  }
  return result
}
