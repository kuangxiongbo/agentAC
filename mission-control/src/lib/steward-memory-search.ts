import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getDatabase } from './db'
import { getSupervisionGoal } from './supervision-goals'
import { getStewardMemory, type StewardMemoryCategory, type StewardMemoryScope, type StewardMemoryView } from './steward-memories'

export interface StewardMemorySearchHit {
  memory: StewardMemoryView
  usage_id: string
  score: number
  matched_scope: string
  snippet: string
}

export interface StewardMemorySearchResult {
  query: string
  hits: StewardMemorySearchHit[]
  context: string
  total_chars: number
}

interface SearchScope {
  type: StewardMemoryScope
  id: string
  weight: number
}

function dbOr(database?: Database.Database) {
  return database ?? getDatabase()
}

function scopesFor(input: {
  workspaceId: number
  tenantId?: number | null
  goalId?: string | null
  projectIds?: number[]
  userId?: string | null
  stewardId?: number | null
  clientId?: string | null
}, db: Database.Database): SearchScope[] {
  const scopes: SearchScope[] = []
  let goal = input.goalId ? getSupervisionGoal(input.goalId, input.workspaceId, db) : null
  if (goal) {
    scopes.push({ type: 'goal', id: goal.id, weight: 100 })
    scopes.push({ type: 'user', id: goal.created_by, weight: 80 })
    scopes.push({ type: 'steward', id: String(goal.steward_local_agent_id), weight: 70 })
    scopes.push({ type: 'client', id: goal.client_id, weight: 60 })
  } else {
    if (input.userId) scopes.push({ type: 'user', id: input.userId, weight: 80 })
    if (input.stewardId) scopes.push({ type: 'steward', id: String(input.stewardId), weight: 70 })
    if (input.clientId) scopes.push({ type: 'client', id: input.clientId, weight: 60 })
  }
  for (const projectId of input.projectIds ?? []) scopes.push({ type: 'project', id: String(projectId), weight: 90 })
  if (input.tenantId != null) scopes.push({ type: 'tenant', id: String(input.tenantId), weight: 50 })
  scopes.push({ type: 'workspace', id: String(input.workspaceId), weight: 40 })
  const unique = new Map(scopes.map((scope) => [`${scope.type}:${scope.id}`, scope]))
  return [...unique.values()]
}

function textScore(memory: StewardMemoryView, query: string): number {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return 0
  const text = `${memory.summary || ''} ${memory.content}`.toLowerCase()
  let score = text.includes(normalizedQuery) ? 30 : 0
  const terms = [...new Set(normalizedQuery.split(/\s+/).map((term) => term.trim()).filter((term) => term.length >= 2))]
  for (const term of terms) if (text.includes(term)) score += 8
  return score
}

export function searchStewardMemories(input: {
  workspaceId: number
  tenantId?: number | null
  query: string
  goalId?: string | null
  projectIds?: number[]
  userId?: string | null
  stewardId?: number | null
  clientId?: string | null
  categories?: StewardMemoryCategory[]
  limit?: number
  maxChars?: number
}, database?: Database.Database): StewardMemorySearchResult {
  const db = dbOr(database)
  const query = input.query.trim().slice(0, 1000)
  if (!query) return { query, hits: [], context: '', total_chars: 0 }
  const scopes = scopesFor(input, db)
  const scopeMap = new Map(scopes.map((scope) => [`${scope.type}:${scope.id}`, scope]))
  const now = Math.floor(Date.now() / 1000)
  const categorySet = input.categories?.length ? new Set(input.categories) : null
  const rows = db.prepare(`
    SELECT * FROM steward_memories
    WHERE workspace_id = ?
      AND status = 'approved'
      AND (tenant_id IS NULL OR tenant_id IS ?)
      AND (effective_at IS NULL OR effective_at <= ?)
      AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY confidence DESC, updated_at DESC
    LIMIT 500
  `).all(input.workspaceId, input.tenantId ?? null, now, now) as Array<Record<string, unknown>>
  const ranked = rows
    .map((row) => getStewardMemory(String(row.id), input.workspaceId, db))
    .filter((memory): memory is StewardMemoryView => Boolean(memory))
    .filter((memory) => !categorySet || categorySet.has(memory.category))
    .map((memory) => {
      const scope = scopeMap.get(`${memory.scope_type}:${memory.scope_id}`)
      if (!scope) return null
      const relevance = textScore(memory, query)
      const categoryBonus = memory.category === 'procedure' ? 8 : memory.category === 'fact' ? 6 : memory.category === 'preference' ? 4 : 2
      return {
        memory,
        scope,
        score: scope.weight + relevance + categoryBonus + Math.round(memory.confidence * 20),
      }
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((left, right) => right.score - left.score || right.memory.confidence - left.memory.confidence)

  const maxChars = Math.min(Math.max(input.maxChars ?? 2000, 200), 10_000)
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 20)
  const hits: StewardMemorySearchHit[] = []
  let usedChars = 0
  for (const item of ranked) {
    if (hits.length >= limit) break
    const prefix = `[${item.memory.category}/${item.memory.scope_type}:${item.memory.scope_id}] `
    const remaining = maxChars - usedChars - prefix.length
    if (remaining <= 20) break
    const snippet = item.memory.content.slice(0, remaining)
    const usageId = randomUUID()
    db.prepare(`
      INSERT INTO steward_memory_usage (
        id, workspace_id, tenant_id, memory_id, goal_id, query_text,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      usageId,
      input.workspaceId,
      input.tenantId ?? null,
      item.memory.id,
      input.goalId ?? null,
      query,
      now,
      now,
    )
    hits.push({
      memory: item.memory,
      usage_id: usageId,
      score: item.score,
      matched_scope: `${item.scope.type}:${item.scope.id}`,
      snippet,
    })
    usedChars += prefix.length + snippet.length + 1
  }
  const context = hits
    .map((hit, index) => `${index + 1}. [${hit.memory.category}/${hit.matched_scope}] ${hit.snippet}`)
    .join('\n')
    .slice(0, maxChars)
  return { query, hits, context, total_chars: context.length }
}

export function recordStewardMemoryUsageOutcome(input: {
  usageId: string
  workspaceId: number
  adopted: boolean
  outcome: 'helpful' | 'harmful' | 'irrelevant'
  score?: number | null
}, database?: Database.Database) {
  const db = dbOr(database)
  const now = Math.floor(Date.now() / 1000)
  return db.transaction(() => {
    const usage = db.prepare(`
      SELECT memory_id FROM steward_memory_usage WHERE id = ? AND workspace_id = ?
    `).get(input.usageId, input.workspaceId) as { memory_id: string } | undefined
    if (!usage) throw new Error('Memory usage not found')
    const boundedScore = input.score == null ? null : Math.min(1, Math.max(0, input.score))
    db.prepare(`
      UPDATE steward_memory_usage
      SET adopted = ?, outcome = ?, score = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?
    `).run(input.adopted ? 1 : 0, input.outcome, boundedScore, now, input.usageId, input.workspaceId)
    const delta = input.outcome === 'helpful' ? 0.03 : input.outcome === 'harmful' ? -0.12 : -0.02
    db.prepare(`
      UPDATE steward_memories
      SET confidence = min(0.99, max(0.05, confidence + ?)), updated_at = ?
      WHERE id = ? AND workspace_id = ?
    `).run(delta, now, usage.memory_id, input.workspaceId)
    return getStewardMemory(usage.memory_id, input.workspaceId, db)
  })()
}

export function recordGoalMemoryOutcomes(
  goalId: string,
  workspaceId: number,
  decision: 'accepted' | 'rejected' | 'needs_human',
  database?: Database.Database,
) {
  const db = dbOr(database)
  const rows = db.prepare(`
    SELECT id FROM steward_memory_usage
    WHERE workspace_id = ? AND goal_id = ? AND outcome IS NULL
  `).all(workspaceId, goalId) as Array<{ id: string }>
  const outcome = decision === 'accepted' ? 'helpful' : decision === 'rejected' ? 'harmful' : 'irrelevant'
  for (const row of rows) {
    recordStewardMemoryUsageOutcome({
      usageId: row.id,
      workspaceId,
      adopted: decision !== 'needs_human',
      outcome,
      score: decision === 'accepted' ? 1 : decision === 'rejected' ? 0 : 0.5,
    }, db)
  }
  return rows.length
}

export function forgetStewardMemories(
  input: { workspaceId?: number; nowSeconds?: number } = {},
  database?: Database.Database,
): { expired: number; harmful: number } {
  const db = dbOr(database)
  const workspaceId = input.workspaceId ?? 1
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000)
  const expired = db.prepare(`
    UPDATE steward_memories SET status = 'expired', updated_at = ?
    WHERE workspace_id = ? AND status = 'approved'
      AND expires_at IS NOT NULL AND expires_at <= ?
  `).run(now, workspaceId, now).changes
  const harmful = db.prepare(`
    UPDATE steward_memories
    SET status = 'expired', updated_at = ?
    WHERE workspace_id = ? AND status = 'approved'
      AND (
        confidence < 0.3
        OR id IN (
          SELECT memory_id FROM steward_memory_usage
          WHERE workspace_id = ? AND outcome = 'harmful'
          GROUP BY memory_id HAVING COUNT(*) >= 3
        )
      )
  `).run(now, workspaceId, workspaceId).changes
  return { expired, harmful }
}
