import type Database from 'better-sqlite3'
import { requestBridgeClientStewardJudge } from './bridge-server'
import { getDatabase } from './db'
import { getSupervisionGoal, listSupervisionGoals, type SupervisionGoalView } from './supervision-goals'
import { consumeSupervisionModelCall } from './supervision-budget'
import { recordGoalMemoryOutcomes, searchStewardMemories } from './steward-memory-search'

type JudgeRunner = typeof requestBridgeClientStewardJudge

interface VerificationTask {
  task_id: number
  logical_task_key: string
  acceptance_criteria_json: string
  title: string
  status: string
  outcome: string | null
  resolution: string | null
  metadata: string | null
  updated_at: number
}

interface VerificationDecision {
  decision: 'accepted' | 'rejected' | 'needs_human'
  reason: string
  criteria: Array<{
    criterion_id: string
    passed: boolean
    evidence_refs: string[]
    note: string
  }>
}

export interface SupervisionVerificationResult {
  goal_id: string
  decision: VerificationDecision['decision']
  reason: string
  criteria: VerificationDecision['criteria']
  evidence_refs: string[]
  status: string
}

function dbOr(database?: Database.Database) {
  return database ?? getDatabase()
}

function parseObject(raw: string | null): Record<string, unknown> {
  try {
    const value = raw ? JSON.parse(raw) : {}
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function listTasks(db: Database.Database, goal: SupervisionGoalView): VerificationTask[] {
  return db.prepare(`
    SELECT sgt.task_id, sgt.logical_task_key, sgt.acceptance_criteria_json,
           t.title, t.status, t.outcome, t.resolution, t.metadata, t.updated_at
    FROM supervision_goal_tasks sgt
    JOIN tasks t ON t.id = sgt.task_id
    WHERE sgt.goal_id = ? AND sgt.plan_version = ?
    ORDER BY t.id
  `).all(goal.id, goal.current_plan_version) as VerificationTask[]
}

function collectEvidence(db: Database.Database, tasks: VerificationTask[]) {
  return tasks.map((task) => {
    const metadata = parseObject(task.metadata)
    const metadataEvidence = Array.isArray(metadata.verification_evidence)
      ? metadata.verification_evidence.filter((item) => item && typeof item === 'object')
      : Array.isArray(metadata.evidence)
        ? metadata.evidence.filter((item) => item && typeof item === 'object')
        : []
    const qualityReviews = db.prepare(`
      SELECT reviewer, status, notes, created_at
      FROM quality_reviews WHERE task_id = ? ORDER BY created_at DESC
    `).all(task.task_id) as Array<Record<string, unknown>>
    const managedCompletion = db.prepare(`
      SELECT id, actor_id, decision, reason, evidence_json, action_json, created_at
      FROM supervision_events
      WHERE task_id = ? AND event_type = 'goal_task_worker_completed'
      ORDER BY id DESC LIMIT 1
    `).get(task.task_id) as {
      id: number
      actor_id: string | null
      decision: string | null
      reason: string | null
      evidence_json: string | null
      action_json: string | null
      created_at: number
    } | undefined
    const independentEvidence = [
      ...metadataEvidence.map((item, index) => ({
        ref: `task:${task.task_id}:metadata-evidence:${index}`,
        value: item,
      })),
      ...qualityReviews.map((review, index) => ({
        ref: `task:${task.task_id}:quality-review:${index}`,
        value: review,
      })),
      ...(managedCompletion ? [{
        ref: `task:${task.task_id}:managed-completion:${managedCompletion.id}`,
        value: {
          source: 'center_validated_worker_completion',
          attestation: 'Center validated Goal/task state, assigned Worker identity and assigned session before recording this event.',
          actor_id: managedCompletion.actor_id,
          decision: managedCompletion.decision,
          reason: managedCompletion.reason,
          evidence: parseObject(managedCompletion.evidence_json),
          assignment: parseObject(managedCompletion.action_json),
          created_at: managedCompletion.created_at,
        },
      }] : []),
    ]
    return {
      task_id: task.task_id,
      logical_key: task.logical_task_key,
      title: task.title,
      status: task.status,
      outcome: task.outcome,
      acceptance_criteria: JSON.parse(task.acceptance_criteria_json) as string[],
      worker_resolution: task.resolution,
      independent_evidence: independentEvidence,
    }
  })
}

function extractJson(raw: string): unknown {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()
  const candidate = fenced || trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1)
  return JSON.parse(candidate)
}

function parseDecision(raw: string, goal: SupervisionGoalView): VerificationDecision {
  const parsed = extractJson(raw) as Partial<VerificationDecision>
  if (!['accepted', 'rejected', 'needs_human'].includes(String(parsed.decision))) {
    throw new Error('VERIFICATION_DECISION_INVALID')
  }
  const reason = String(parsed.reason || '').trim()
  if (!reason) throw new Error('VERIFICATION_REASON_REQUIRED')
  if (!Array.isArray(parsed.criteria)) throw new Error('VERIFICATION_CRITERIA_REQUIRED')
  const criteria = parsed.criteria.map((item) => ({
    criterion_id: String(item?.criterion_id || ''),
    passed: item?.passed === true,
    evidence_refs: Array.isArray(item?.evidence_refs)
      ? item.evidence_refs.filter((ref): ref is string => typeof ref === 'string' && Boolean(ref.trim()))
      : [],
    note: String(item?.note || ''),
  }))
  const expectedIds = new Set(goal.success_criteria.map((criterion) => criterion.id))
  if (criteria.length !== expectedIds.size || criteria.some((criterion) => !expectedIds.has(criterion.criterion_id))) {
    throw new Error('VERIFICATION_CRITERIA_MISMATCH')
  }
  return { decision: parsed.decision as VerificationDecision['decision'], reason, criteria }
}

function verificationPrompt(goal: SupervisionGoalView, evidence: ReturnType<typeof collectEvidence>, memoryContext = ''): string {
  return `你是独立验收值守 Agent。你不能把 Worker 自报“完成”作为唯一证据，必须逐条核对成功标准与独立证据。

只输出 JSON：
{
  "decision":"accepted|rejected|needs_human",
  "reason":"总体判断",
  "criteria":[{"criterion_id":"标准 ID","passed":true,"evidence_refs":["证据 ref"],"note":"判断"}]
}

规则：
1. 每条成功标准必须恰好返回一次。
2. accepted 要求所有标准 passed=true 且每条至少引用一个 independent_evidence ref。
3. Worker resolution 仅用于理解，不能单独证明通过。
4. source=center_validated_worker_completion 表示中心已校验 Goal/task 状态、Worker 和 session 后接受 MCP 完成提交；其结构化 evidence 可证明本次受管提交内容，但出现冲突时仍返回 needs_human。
5. 证据冲突或需要真实环境确认时返回 needs_human。

目标：${goal.title}
目标描述：${goal.objective}
成功标准：${JSON.stringify(goal.success_criteria)}
约束：${JSON.stringify(goal.constraints)}
任务与证据：${JSON.stringify(evidence)}
${memoryContext ? `\n已批准值守记忆（只能辅助理解，不能替代本次独立证据）：\n${memoryContext}` : ''}`
}

function recordVerification(db: Database.Database, goal: SupervisionGoalView, decision: VerificationDecision, evidenceRefs: string[]) {
  const nextStatus = decision.decision === 'accepted'
    ? 'completed'
    : decision.decision === 'rejected'
      ? 'running'
      : 'blocked'
  const now = Math.floor(Date.now() / 1000)
  db.transaction(() => {
    const updated = db.prepare(`
      UPDATE supervision_goals
      SET status = ?, version = version + 1, updated_at = ?,
          completed_at = CASE WHEN ? = 'completed' THEN ? ELSE NULL END
      WHERE id = ? AND workspace_id = ? AND status = 'verifying'
    `).run(nextStatus, now, nextStatus, now, goal.id, goal.workspace_id)
    if (updated.changes !== 1) throw new Error('GOAL_STATE_CONFLICT')
    db.prepare(`
      INSERT OR IGNORE INTO supervision_events (
        workspace_id, tenant_id, goal_id, event_type, actor_type, actor_id,
        decision, reason, evidence_json, action_json, idempotency_key
      ) VALUES (?, ?, ?, 'goal_verification_completed', 'steward_agent', ?, ?, ?, ?, ?, ?)
    `).run(
      goal.workspace_id,
      goal.tenant_id,
      goal.id,
      String(goal.steward_local_agent_id),
      decision.decision,
      decision.reason,
      JSON.stringify({ criteria: decision.criteria, evidence_refs: evidenceRefs }),
      JSON.stringify({ from_status: 'verifying', to_status: nextStatus }),
      `goal:${goal.id}:plan:${goal.current_plan_version}:verification:${goal.version}`,
    )
  })()
  return nextStatus
}

export async function verifySupervisionGoal(
  input: { goalId: string; workspaceId: number },
  dependencies: { runJudge?: JudgeRunner } = {},
  database?: Database.Database,
): Promise<SupervisionVerificationResult> {
  const db = dbOr(database)
  const goal = getSupervisionGoal(input.goalId, input.workspaceId, db)
  if (!goal) throw new Error('Goal not found')
  if (goal.status !== 'verifying') throw new Error(`Invalid goal state for verification: ${goal.status}`)
  const tasks = listTasks(db, goal)
  if (tasks.length === 0 || tasks.some((task) => task.status !== 'done')) {
    throw new Error('GOAL_TASKS_NOT_COMPLETE')
  }
  const evidence = collectEvidence(db, tasks)
  const evidenceRefs = evidence.flatMap((task) => task.independent_evidence.map((item) => item.ref))
  let decision: VerificationDecision
  if (evidence.some((task) => task.independent_evidence.length === 0)) {
    decision = {
      decision: 'needs_human',
      reason: 'At least one task has only Worker self-report and no independent evidence',
      criteria: goal.success_criteria.map((criterion) => ({
        criterion_id: criterion.id,
        passed: false,
        evidence_refs: [],
        note: 'Independent evidence is missing',
      })),
    }
  } else {
    const runJudge = dependencies.runJudge ?? requestBridgeClientStewardJudge
    const memory = searchStewardMemories({
      workspaceId: goal.workspace_id,
      tenantId: goal.tenant_id,
      goalId: goal.id,
      query: `${goal.title} ${goal.objective} ${goal.success_criteria.map((item) => item.text).join(' ')}`,
      categories: ['fact', 'procedure', 'episode'],
      limit: 5,
      maxChars: 1600,
    }, db)
    consumeSupervisionModelCall({ goalId: goal.id, workspaceId: goal.workspace_id }, db)
    const result = await runJudge({
      clientId: goal.client_id,
      localAgentId: goal.steward_local_agent_id,
      prompt: verificationPrompt(goal, evidence, memory.context),
      timeoutMs: 600_000,
    })
    decision = parseDecision(result.reply, goal)
    if (decision.decision === 'accepted') {
      const allowedRefs = new Set(evidenceRefs)
      const unsupported = decision.criteria.some((criterion) =>
        !criterion.passed
        || criterion.evidence_refs.length === 0
        || criterion.evidence_refs.some((ref) => !allowedRefs.has(ref)),
      )
      if (unsupported) {
        decision = {
          ...decision,
          decision: 'needs_human',
          reason: 'Verifier acceptance did not cite valid independent evidence for every criterion',
        }
      }
    }
  }
  const status = recordVerification(db, goal, decision, evidenceRefs)
  recordGoalMemoryOutcomes(goal.id, goal.workspace_id, decision.decision, db)
  return {
    goal_id: goal.id,
    decision: decision.decision,
    reason: decision.reason,
    criteria: decision.criteria,
    evidence_refs: evidenceRefs,
    status,
  }
}

export async function runSupervisionVerifications(
  input: { workspaceId?: number; limit?: number } = {},
  dependencies: { runJudge?: JudgeRunner } = {},
  database?: Database.Database,
): Promise<{ processed: number; accepted: number; rejected: number; needs_human: number; errors: string[] }> {
  const db = dbOr(database)
  const goals = listSupervisionGoals({
    workspaceId: input.workspaceId ?? 1,
    status: 'verifying',
    limit: Math.min(Math.max(input.limit ?? 20, 1), 100),
  }, db).goals
  const summary = { processed: 0, accepted: 0, rejected: 0, needs_human: 0, errors: [] as string[] }
  for (const goal of goals) {
    try {
      const result = await verifySupervisionGoal({ goalId: goal.id, workspaceId: goal.workspace_id }, dependencies, db)
      summary.processed++
      summary[result.decision]++
    } catch (error) {
      summary.errors.push(`goal=${goal.id}: ${error instanceof Error ? error.message : 'verification failed'}`)
    }
  }
  return summary
}
