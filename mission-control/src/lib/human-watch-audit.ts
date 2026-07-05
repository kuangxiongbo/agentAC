import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getDatabase } from './db'
import type {
  HumanWatchInterventionRow,
  ListHumanWatchInterventionsFilters,
  LogHumanWatchInterventionInput,
} from './human-watch-types'

const PROMPT_PREVIEW_MAX = 500

function dbOr(database?: Database.Database): Database.Database {
  return database ?? getDatabase()
}

export function hashHumanWatchPrompt(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function truncateHumanWatchPromptPreview(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= PROMPT_PREVIEW_MAX) return trimmed
  return `${trimmed.slice(0, PROMPT_PREVIEW_MAX)}…`
}

/**
 * Append-only intervention audit log (center authority).
 */
export function logHumanWatchIntervention(
  input: LogHumanWatchInterventionInput,
  database?: Database.Database,
): HumanWatchInterventionRow | null {
  const db = dbOr(database)

  if (
    input.eventType === 'intervention_completed'
    && input.outcome === 'success'
    && input.fingerprint
    && input.bindingId != null
  ) {
    const existing = db
      .prepare(
        `SELECT id FROM human_watch_interventions
         WHERE binding_id = ?
           AND fingerprint = ?
           AND event_type = 'intervention_completed'
           AND outcome = 'success'
         LIMIT 1`,
      )
      .get(input.bindingId, input.fingerprint) as { id: number } | undefined
    if (existing) return null
  }

  const promptPreview = input.promptPreview != null
    ? truncateHumanWatchPromptPreview(input.promptPreview)
    : null
  const promptSha256 = input.promptSha256
    ?? (input.promptPreview != null ? hashHumanWatchPrompt(input.promptPreview) : null)

  const rulesHitJson = input.rulesHit != null ? JSON.stringify(input.rulesHit) : null

  const result = db
    .prepare(
      `INSERT INTO human_watch_interventions (
        workspace_id, tenant_id, client_id, binding_id,
        worker_sync_index_id, worker_local_agent_id, worker_name,
        steward_sync_index_id, steward_local_agent_id, steward_name,
        worker_session_id, event_type, decision, rules_hit, fingerprint,
        prompt_preview, prompt_sha256, outcome, error_message, bridge_request_id,
        message_id, correlation_id, llm_sweep, skip_reason, created_at
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, unixepoch()
      )`,
    )
    .run(
      input.workspaceId,
      input.tenantId ?? null,
      input.clientId,
      input.bindingId ?? null,
      input.workerSyncIndexId ?? null,
      input.workerLocalAgentId ?? null,
      input.workerName ?? null,
      input.stewardSyncIndexId ?? null,
      input.stewardLocalAgentId ?? null,
      input.stewardName ?? null,
      input.workerSessionId ?? null,
      input.eventType,
      input.decision ?? null,
      rulesHitJson,
      input.fingerprint ?? null,
      promptPreview,
      promptSha256,
      input.outcome ?? null,
      input.errorMessage ?? null,
      input.bridgeRequestId ?? null,
      input.messageId ?? null,
      input.correlationId ?? null,
      input.llmSweep ? 1 : 0,
      input.skipReason ?? null,
    )

  const id = Number(result.lastInsertRowid)
  return getHumanWatchInterventionById(id, db)
}

export function getHumanWatchInterventionById(
  id: number,
  database?: Database.Database,
): HumanWatchInterventionRow | null {
  const db = dbOr(database)
  const row = db
    .prepare(`SELECT * FROM human_watch_interventions WHERE id = ?`)
    .get(id) as HumanWatchInterventionRow | undefined
  return row ?? null
}

export function hasSuccessfulInterventionFingerprint(
  bindingId: number,
  fingerprint: string,
  database?: Database.Database,
): boolean {
  const db = dbOr(database)
  const row = db
    .prepare(
      `SELECT id FROM human_watch_interventions
       WHERE binding_id = ?
         AND fingerprint = ?
         AND event_type = 'intervention_completed'
         AND outcome = 'success'
       LIMIT 1`,
    )
    .get(bindingId, fingerprint) as { id: number } | undefined
  return Boolean(row)
}

export function getLastInterventionCompletedAt(
  bindingId: number,
  database?: Database.Database,
): number | null {
  const db = dbOr(database)
  const row = db
    .prepare(
      `SELECT created_at FROM human_watch_interventions
       WHERE binding_id = ? AND event_type = 'intervention_completed'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(bindingId) as { created_at?: number } | undefined
  return row?.created_at ?? null
}

export function countSuccessfulInterventionsSince(
  bindingId: number,
  sinceSec: number,
  database?: Database.Database,
): number {
  const db = dbOr(database)
  const row = db
    .prepare(
      `SELECT COUNT(*) as c FROM human_watch_interventions
       WHERE binding_id = ?
         AND event_type = 'intervention_completed'
         AND outcome = 'success'
         AND created_at >= ?`,
    )
    .get(bindingId, sinceSec) as { c?: number } | undefined
  return row?.c ?? 0
}

export function listHumanWatchInterventions(
  filters: ListHumanWatchInterventionsFilters,
  database?: Database.Database,
): HumanWatchInterventionRow[] {
  const db = dbOr(database)
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200)

  const clauses = ['workspace_id = ?']
  const params: Array<string | number> = [filters.workspaceId]

  if (filters.tenantId != null) {
    clauses.push('tenant_id = ?')
    params.push(filters.tenantId)
  }
  if (filters.clientId) {
    clauses.push('client_id = ?')
    params.push(filters.clientId)
  }
  if (filters.bindingId != null) {
    clauses.push('binding_id = ?')
    params.push(filters.bindingId)
  }
  if (filters.workerSyncIndexId != null) {
    clauses.push('worker_sync_index_id = ?')
    params.push(filters.workerSyncIndexId)
  }
  if (filters.workerLocalAgentId != null) {
    clauses.push('worker_local_agent_id = ?')
    params.push(filters.workerLocalAgentId)
  }
  if (filters.stewardSyncIndexId != null) {
    clauses.push('steward_sync_index_id = ?')
    params.push(filters.stewardSyncIndexId)
  }
  if (filters.stewardLocalAgentId != null) {
    clauses.push('steward_local_agent_id = ?')
    params.push(filters.stewardLocalAgentId)
  }
  if (filters.since != null) {
    clauses.push('created_at >= ?')
    params.push(filters.since)
  }

  params.push(limit)

  return db
    .prepare(
      `SELECT * FROM human_watch_interventions
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(...params) as HumanWatchInterventionRow[]
}
