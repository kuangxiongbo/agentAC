import type Database from 'better-sqlite3'
import { requestBridgeClientStewardJudge } from './bridge-server'
import { getDatabase } from './db'
import { getSupervisionGoal, listSupervisionGoals, type SupervisionGoalView } from './supervision-goals'
import {
  createStewardMemory,
  getStewardMemory,
  type StewardMemoryCategory,
  type StewardMemoryScope,
  type StewardMemoryView,
} from './steward-memories'

type JudgeRunner = typeof requestBridgeClientStewardJudge

interface MemoryCandidateDraft {
  category: StewardMemoryCategory
  scope_type: StewardMemoryScope
  scope_id: string
  content: string
  summary?: string
  confidence: number
  evidence_note: string
  expires_at?: number | null
}

const CATEGORIES = new Set(['preference', 'fact', 'episode', 'procedure'])
const SCOPES = new Set(['goal', 'project', 'user', 'steward', 'client', 'workspace', 'tenant'])
const MAX_JUDGE_PROMPT_CHARS = 6000

function boundedText(value: unknown, maxChars: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text.length <= maxChars) return text
  const marker = '...[truncated]...'
  const remaining = Math.max(0, maxChars - marker.length)
  const head = Math.ceil(remaining * 0.6)
  return `${text.slice(0, head)}${marker}${text.slice(text.length - (remaining - head))}`
}

function dbOr(database?: Database.Database) {
  return database ?? getDatabase()
}

function extractJson(raw: string): unknown {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()
  const candidate = fenced || trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1)
  return JSON.parse(candidate)
}

function normalizeDrafts(raw: string, goal: SupervisionGoalView, projectIds: number[]): MemoryCandidateDraft[] {
  const parsed = extractJson(raw) as { candidates?: unknown[] }
  if (!Array.isArray(parsed.candidates)) throw new Error('MEMORY_CANDIDATES_REQUIRED')
  if (parsed.candidates.length > 5) throw new Error('MEMORY_CANDIDATE_LIMIT_EXCEEDED')
  return parsed.candidates.map((item, index) => {
    const value = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    const category = String(value.category || '') as StewardMemoryCategory
    const scopeType = String(value.scope_type || '') as StewardMemoryScope
    const scopeId = String(value.scope_id || '').trim()
    const content = String(value.content || '').trim()
    const confidence = Number(value.confidence)
    const evidenceNote = String(value.evidence_note || '').trim()
    if (!CATEGORIES.has(category)) throw new Error(`MEMORY_CATEGORY_INVALID:${index}`)
    if (!SCOPES.has(scopeType)) throw new Error(`MEMORY_SCOPE_INVALID:${index}`)
    if (!content || content.length > 2000) throw new Error(`MEMORY_CONTENT_INVALID:${index}`)
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error(`MEMORY_CONFIDENCE_INVALID:${index}`)
    if (!evidenceNote) throw new Error(`MEMORY_EVIDENCE_REQUIRED:${index}`)
    const allowedScopeIds: Record<StewardMemoryScope, string[]> = {
      goal: [goal.id],
      project: projectIds.map(String),
      user: [goal.created_by],
      steward: [String(goal.steward_local_agent_id)],
      client: [goal.client_id],
      workspace: [String(goal.workspace_id)],
      tenant: goal.tenant_id == null ? [] : [String(goal.tenant_id)],
    }
    if (!allowedScopeIds[scopeType].includes(scopeId)) throw new Error(`MEMORY_SCOPE_ID_INVALID:${index}`)
    return {
      category,
      scope_type: scopeType,
      scope_id: scopeId,
      content,
      summary: typeof value.summary === 'string' ? value.summary.trim() : undefined,
      confidence,
      evidence_note: evidenceNote,
      expires_at: value.expires_at == null
        ? null
        : Number.isFinite(Number(value.expires_at)) ? Number(value.expires_at) : null,
    }
  })
}

function learningContext(db: Database.Database, goal: SupervisionGoalView) {
  const tasks = db.prepare(`
    SELECT t.id, t.title, t.outcome, t.resolution, t.metadata, t.project_id
    FROM supervision_goal_tasks sgt
    JOIN tasks t ON t.id = sgt.task_id
    WHERE sgt.goal_id = ? AND sgt.plan_version = ?
    ORDER BY t.id
  `).all(goal.id, goal.current_plan_version) as Array<{
    id: number
    title: string
    outcome: string | null
    resolution: string | null
    metadata: string | null
    project_id: number | null
  }>
  const events = db.prepare(`
    SELECT event_type, decision, reason, evidence_json, action_json
    FROM supervision_events WHERE goal_id = ? ORDER BY id
  `).all(goal.id)
  return {
    tasks,
    events,
    projectIds: [...new Set(tasks.map((task) => task.project_id).filter((id): id is number => Boolean(id)))],
  }
}

function learningPrompt(goal: SupervisionGoalView, context: ReturnType<typeof learningContext>): string {
  const prompt = `你是值守 Agent 的受控记忆提取器。根据已完成目标提取可复用候选，不要把一次偶然输出当成长期事实。

只输出 JSON：
{"candidates":[{"category":"preference|fact|episode|procedure","scope_type":"goal|project|user|steward|client|workspace|tenant","scope_id":"合法 ID","content":"原子化记忆","summary":"摘要","confidence":0.0,"evidence_note":"来源依据","expires_at":null}]}

最多 5 条。允许的 scope_id：
- goal: ${goal.id}
- project: ${context.projectIds.join(', ') || '(无)'}
- user: ${goal.created_by}
- steward: ${goal.steward_local_agent_id}
- client: ${goal.client_id}
- workspace: ${goal.workspace_id}
- tenant: ${goal.tenant_id ?? '(无)'}

目标：${boundedText(goal.title, 300)}
目标描述：${boundedText(goal.objective, 900)}
约束：${boundedText(goal.constraints, 500)}
成功标准：${boundedText(goal.success_criteria, 700)}
任务结果：${boundedText(context.tasks, 1500)}
监督事件：${boundedText(context.events, 1200)}`
  return boundedText(prompt, MAX_JUDGE_PROMPT_CHARS)
}

function mergeCandidate(
  db: Database.Database,
  goal: SupervisionGoalView,
  draft: MemoryCandidateDraft,
): StewardMemoryView {
  const sourceRef = `goal:${goal.id}`
  const existingRow = db.prepare(`
    SELECT id FROM steward_memories
    WHERE workspace_id = ? AND tenant_id IS ? AND scope_type = ? AND scope_id = ?
      AND category = ? AND lower(trim(content)) = lower(trim(?))
      AND status IN ('candidate', 'approved')
    ORDER BY updated_at DESC LIMIT 1
  `).get(
    goal.workspace_id,
    goal.tenant_id,
    draft.scope_type,
    draft.scope_id,
    draft.category,
    draft.content,
  ) as { id: string } | undefined
  if (!existingRow) {
    return createStewardMemory({
      workspaceId: goal.workspace_id,
      tenantId: goal.tenant_id,
      scopeType: draft.scope_type,
      scopeId: draft.scope_id,
      category: draft.category,
      content: draft.content,
      summary: draft.summary,
      sourceRefs: [sourceRef],
      evidence: [{ goal_id: goal.id, outcome: 'success', note: draft.evidence_note }],
      confidence: draft.confidence,
      expiresAt: draft.expires_at,
      createdByType: 'steward_agent',
    }, db)
  }
  const existing = getStewardMemory(existingRow.id, goal.workspace_id, db)!
  const sourceRefs = [...new Set([...existing.source_refs, sourceRef])]
  const evidence = existing.evidence.some((item) => item.goal_id === goal.id)
    ? existing.evidence
    : [...existing.evidence, { goal_id: goal.id, outcome: 'success', note: draft.evidence_note }]
  const autoPromote = existing.status === 'candidate'
    && draft.category === 'procedure'
    && sourceRefs.filter((ref) => ref.startsWith('goal:')).length >= 3
  db.prepare(`
    UPDATE steward_memories
    SET source_refs_json = ?, evidence_json = ?,
        confidence = ?, status = ?, effective_at = COALESCE(effective_at, ?),
        updated_at = ?
    WHERE id = ?
  `).run(
    JSON.stringify(sourceRefs),
    JSON.stringify(evidence),
    Math.min(0.99, Math.max(existing.confidence, draft.confidence) + (sourceRefs.length - existing.source_refs.length) * 0.05),
    autoPromote ? 'approved' : existing.status,
    autoPromote ? Math.floor(Date.now() / 1000) : null,
    Math.floor(Date.now() / 1000),
    existing.id,
  )
  return getStewardMemory(existing.id, goal.workspace_id, db)!
}

export async function extractStewardMemoryCandidates(
  input: { goalId: string; workspaceId: number },
  dependencies: { runJudge?: JudgeRunner } = {},
  database?: Database.Database,
): Promise<{ memories: StewardMemoryView[]; duplicate: boolean }> {
  const db = dbOr(database)
  const goal = getSupervisionGoal(input.goalId, input.workspaceId, db)
  if (!goal) throw new Error('Goal not found')
  if (goal.status !== 'completed') throw new Error('Only completed goals can produce memory candidates')
  const marker = `goal:${goal.id}:memory-candidates-extracted`
  const existingMarker = db.prepare(`
    SELECT action_json FROM supervision_events WHERE workspace_id = ? AND idempotency_key = ?
  `).get(goal.workspace_id, marker) as { action_json: string | null } | undefined
  if (existingMarker) return { memories: [], duplicate: true }
  const context = learningContext(db, goal)
  const runJudge = dependencies.runJudge ?? requestBridgeClientStewardJudge
  const result = await runJudge({
    clientId: goal.client_id,
    localAgentId: goal.steward_local_agent_id,
    prompt: learningPrompt(goal, context),
    timeoutMs: 600_000,
  })
  const drafts = normalizeDrafts(result.reply, goal, context.projectIds)
  const memories = db.transaction(() => {
    const saved = drafts.map((draft) => mergeCandidate(db, goal, draft))
    db.prepare(`
      INSERT INTO supervision_events (
        workspace_id, tenant_id, goal_id, event_type, actor_type, actor_id,
        decision, reason, action_json, idempotency_key
      ) VALUES (?, ?, ?, 'memory_candidates_extracted', 'steward_agent', ?,
        'candidate', ?, ?, ?)
    `).run(
      goal.workspace_id,
      goal.tenant_id,
      goal.id,
      String(goal.steward_local_agent_id),
      `Extracted ${saved.length} memory candidates`,
      JSON.stringify({ memory_ids: saved.map((memory) => memory.id) }),
      marker,
    )
    return saved
  })()
  return { memories, duplicate: false }
}

export async function runStewardMemoryLearning(
  input: { workspaceId?: number; limit?: number; retryCooldownSeconds?: number; maxScheduledAttempts?: number } = {},
  dependencies: { runJudge?: JudgeRunner; now?: () => number } = {},
  database?: Database.Database,
): Promise<{ processed: number; candidates: number; skipped_cooldown: number; skipped_exhausted: number; errors: string[] }> {
  const db = dbOr(database)
  const now = dependencies.now?.() ?? Math.floor(Date.now() / 1000)
  const retryCooldownSeconds = Math.min(Math.max(input.retryCooldownSeconds ?? 900, 0), 86400)
  const maxScheduledAttempts = Math.min(Math.max(input.maxScheduledAttempts ?? 3, 1), 20)
  const goals = listSupervisionGoals({
    workspaceId: input.workspaceId ?? 1,
    status: 'completed',
    limit: Math.min(Math.max(input.limit ?? 10, 1), 50),
  }, db).goals
  const summary = { processed: 0, candidates: 0, skipped_cooldown: 0, skipped_exhausted: 0, errors: [] as string[] }
  for (const goal of goals) {
    const failureMarker = `goal:${goal.id}:memory-candidates-extraction-failed`
    const recentFailure = db.prepare(`
      SELECT created_at, action_json FROM supervision_events
      WHERE workspace_id = ? AND idempotency_key = ?
    `).get(goal.workspace_id, failureMarker) as { created_at: number; action_json: string | null } | undefined
    let scheduledAttempts = 0
    try {
      scheduledAttempts = Number(JSON.parse(recentFailure?.action_json || '{}').attempts || 0)
    } catch {}
    if (scheduledAttempts >= maxScheduledAttempts) {
      summary.skipped_exhausted++
      continue
    }
    if (recentFailure && recentFailure.created_at > now - retryCooldownSeconds && retryCooldownSeconds > 0) {
      summary.skipped_cooldown++
      continue
    }
    try {
      const result = await extractStewardMemoryCandidates({ goalId: goal.id, workspaceId: goal.workspace_id }, dependencies, db)
      if (!result.duplicate) {
        summary.processed++
        summary.candidates += result.memories.length
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'memory extraction failed'
      summary.errors.push(`goal=${goal.id}: ${message}`)
      const previous = db.prepare(`
        SELECT action_json FROM supervision_events WHERE workspace_id = ? AND idempotency_key = ?
      `).get(goal.workspace_id, failureMarker) as { action_json: string | null } | undefined
      let attempts = scheduledAttempts + 1
      if (previous && scheduledAttempts === 0) {
        try { attempts = Number(JSON.parse(previous.action_json || '{}').attempts || 0) + 1 } catch {}
      }
      db.prepare(`
        INSERT INTO supervision_events (
          workspace_id, tenant_id, goal_id, event_type, actor_type, actor_id,
          decision, reason, action_json, idempotency_key, created_at
        ) VALUES (?, ?, ?, 'memory_candidates_extraction_failed', 'steward_agent', ?,
          'failed', ?, ?, ?, ?)
        ON CONFLICT(workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE SET
          reason = excluded.reason,
          action_json = excluded.action_json,
          created_at = excluded.created_at
      `).run(
        goal.workspace_id,
        goal.tenant_id,
        goal.id,
        String(goal.steward_local_agent_id),
        message.slice(0, 5000),
        JSON.stringify({ attempts, retry_after: now + retryCooldownSeconds }),
        failureMarker,
        now,
      )
    }
  }
  return summary
}
