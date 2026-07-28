import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getDatabase } from './db'
import type {
  HumanWatchEventAction,
  HumanWatchEventPriority,
  HumanWatchEventRow,
  HumanWatchEventSource,
  HumanWatchEventStatus,
  HumanWatchEventView,
  ListHumanWatchEventsFilters,
} from './human-watch-types'

function dbOr(database?: Database.Database): Database.Database {
  return database ?? getDatabase()
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function eventAuditList(context: Record<string, unknown> | null): Array<Record<string, unknown>> {
  const raw = context?.event_audit
  return Array.isArray(raw)
    ? raw.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    : []
}

function appendEventAudit(
  context: Record<string, unknown> | null,
  eventName: string,
  detail: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...(context ?? {}),
    event_audit: [
      ...eventAuditList(context),
      {
        event_name: eventName,
        created_at: Math.floor(Date.now() / 1000),
        ...detail,
      },
    ],
  }
}

const HUMAN_RESOLVER_TYPES = new Set(['human_user', 'human_external'])

/**
 * Records whether a human's decision matched the judge's original suggestion, so
 * acceptance/override rates can be reviewed later without changing judge behavior.
 */
function judgeSuggestionOutcomeAudit(
  input: UpdateHumanWatchEventInput,
  current: HumanWatchEventRow,
  context: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (input.resolvedAction == null) return context
  const resolvedByType = input.resolvedByType ?? current.resolved_by_type
  if (!resolvedByType || !HUMAN_RESOLVER_TYPES.has(resolvedByType)) return context
  const suggestedAction = current.suggested_action
  if (!suggestedAction) return context
  return appendEventAudit(context, 'judge_suggestion_outcome', {
    suggested_action: suggestedAction,
    resolved_action: input.resolvedAction,
    accepted: suggestedAction === input.resolvedAction,
  })
}

function rowToView(row: HumanWatchEventRow): HumanWatchEventView {
  return {
    ...row,
    context: parseJsonObject(row.context_json),
  }
}

export interface CreateHumanWatchEventInput {
  id?: string
  workspaceId: number
  tenantId?: number | null
  clientId: string
  bindingId?: number | null
  workerSyncIndexId?: number | null
  workerLocalAgentId?: number | null
  workerName?: string | null
  workerSessionId?: string | null
  stewardSyncIndexId?: number | null
  stewardLocalAgentId?: number | null
  stewardName?: string | null
  permissionRequestId?: string | null
  source: HumanWatchEventSource
  status?: HumanWatchEventStatus
  priority?: HumanWatchEventPriority
  title: string
  summary: string
  context?: Record<string, unknown> | null
  latestWorkerMessage?: string | null
  suggestedAction?: HumanWatchEventAction | null
  dedupeKey?: string | null
}

export interface UpdateHumanWatchEventInput {
  status?: HumanWatchEventStatus
  latestWorkerMessage?: string | null
  suggestedAction?: HumanWatchEventAction | null
  resolvedAction?: HumanWatchEventAction | null
  resolvedNote?: string | null
  claimedByType?: 'human_user' | 'human_external' | 'steward_agent' | 'system' | null
  claimedByUserId?: number | null
  claimedByAgentId?: string | null
  resolvedByType?: 'human_user' | 'human_external' | 'steward_agent' | 'system' | null
  resolvedByUserId?: number | null
  resolvedByAgentId?: string | null
  contextPatch?: Record<string, unknown> | null
}

export function createHumanWatchEvent(
  input: CreateHumanWatchEventInput,
  database?: Database.Database,
): HumanWatchEventView {
  const db = dbOr(database)
  const id = (input.id || randomUUID()).trim()
  const dedupeKey = input.dedupeKey?.trim() || null
  if (dedupeKey) {
    const existing = db
      .prepare(
        `SELECT * FROM human_watch_events
         WHERE workspace_id = ?
           AND client_id = ?
           AND dedupe_key = ?
           AND status IN ('pending', 'visible', 'claimed')
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(input.workspaceId, input.clientId, dedupeKey) as HumanWatchEventRow | undefined
    if (existing) return rowToView(existing)
  }

  const contextWithAudit = appendEventAudit(input.context ?? null, 'watch_event_created', {
    source: input.source,
    priority: input.priority ?? 'medium',
  })

  db.prepare(
    `INSERT INTO human_watch_events (
      id, workspace_id, tenant_id, client_id, binding_id,
      worker_sync_index_id, worker_local_agent_id, worker_name, worker_session_id,
      steward_sync_index_id, steward_local_agent_id, steward_name, permission_request_id,
      source, status, priority, title, summary, context_json, latest_worker_message,
      suggested_action, dedupe_key, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, unixepoch(), unixepoch()
    )`,
  ).run(
    id,
    input.workspaceId,
    input.tenantId ?? null,
    input.clientId,
    input.bindingId ?? null,
    input.workerSyncIndexId ?? null,
    input.workerLocalAgentId ?? null,
    input.workerName ?? null,
    input.workerSessionId ?? null,
    input.stewardSyncIndexId ?? null,
    input.stewardLocalAgentId ?? null,
    input.stewardName ?? null,
    input.permissionRequestId ?? null,
    input.source,
    input.status ?? 'pending',
    input.priority ?? 'medium',
    input.title,
    input.summary,
    JSON.stringify(contextWithAudit),
    input.latestWorkerMessage ?? null,
    input.suggestedAction ?? null,
    dedupeKey,
  )

  const row = db
    .prepare(`SELECT * FROM human_watch_events WHERE id = ? LIMIT 1`)
    .get(id) as HumanWatchEventRow | undefined
  if (!row) throw new Error(`Failed to create human watch event ${id}`)
  const view = rowToView(row)
  import('./event-bus').then(({ eventBus }) => eventBus.broadcast('human_watch.event', view)).catch(() => {})
  return view
}

export function getHumanWatchEvent(
  id: string,
  workspaceId: number,
  database?: Database.Database,
): HumanWatchEventView | null {
  const db = dbOr(database)
  const row = db
    .prepare(`SELECT * FROM human_watch_events WHERE id = ? AND workspace_id = ? LIMIT 1`)
    .get(id, workspaceId) as HumanWatchEventRow | undefined
  return row ? rowToView(row) : null
}

export function hasActiveHumanWatchEventDedupeKey(
  workspaceId: number,
  clientId: string,
  dedupeKey: string,
  database?: Database.Database,
): boolean {
  const row = dbOr(database).prepare(`
    SELECT 1
    FROM human_watch_events
    WHERE workspace_id = ?
      AND client_id = ?
      AND dedupe_key = ?
      AND status IN ('pending', 'visible', 'claimed')
    LIMIT 1
  `).get(workspaceId, clientId, dedupeKey)
  return Boolean(row)
}

export function listHumanWatchEvents(
  filters: ListHumanWatchEventsFilters,
  database?: Database.Database,
): HumanWatchEventView[] {
  const db = dbOr(database)
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
  if (filters.workerLocalAgentId != null) {
    clauses.push('worker_local_agent_id = ?')
    params.push(filters.workerLocalAgentId)
  }
  if (filters.stewardLocalAgentId != null) {
    clauses.push('steward_local_agent_id = ?')
    params.push(filters.stewardLocalAgentId)
  }
  if (filters.workerSessionId) {
    clauses.push('worker_session_id = ?')
    params.push(filters.workerSessionId)
  }
  if (filters.permissionRequestId) {
    clauses.push('permission_request_id = ?')
    params.push(filters.permissionRequestId)
  }
  if (filters.source) {
    clauses.push('source = ?')
    params.push(filters.source)
  }
  if (filters.status) {
    clauses.push('status = ?')
    params.push(filters.status)
  }

  params.push(Math.min(Math.max(filters.limit ?? 50, 1), 200))

  const rows = db
    .prepare(
      `SELECT * FROM human_watch_events
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(...params) as HumanWatchEventRow[]
  return rows.map(rowToView)
}

export function updateHumanWatchEvent(
  id: string,
  workspaceId: number,
  input: UpdateHumanWatchEventInput,
  database?: Database.Database,
): HumanWatchEventView | null {
  const db = dbOr(database)
  const current = db
    .prepare(`SELECT * FROM human_watch_events WHERE id = ? AND workspace_id = ? LIMIT 1`)
    .get(id, workspaceId) as HumanWatchEventRow | undefined
  if (!current) return null

  const existingContext = parseJsonObject(current.context_json)
  const nextContext =
    input.contextPatch && typeof input.contextPatch === 'object'
      ? { ...(existingContext ?? {}), ...input.contextPatch }
      : existingContext
  const judgeFeedbackContext = judgeSuggestionOutcomeAudit(input, current, nextContext)
  const nextContextWithAudit =
    input.resolvedAction != null
      ? appendEventAudit(judgeFeedbackContext, 'watch_event_closed', {
          action: input.resolvedAction,
          status: input.status ?? current.status,
          resolved_by_type: input.resolvedByType ?? current.resolved_by_type,
        })
      : input.claimedByType != null
        ? appendEventAudit(nextContext, 'watch_event_claimed', {
            status: input.status ?? current.status,
            claimed_by_type: input.claimedByType,
          })
        : input.status === 'visible' && current.status !== 'visible'
          ? appendEventAudit(nextContext, 'watch_event_visible', {})
          : nextContext

  const nextStatus = input.status ?? current.status
  const claimedAt =
    input.claimedByType && current.claimed_at == null
      ? Math.floor(Date.now() / 1000)
      : current.claimed_at
  const resolvedAt =
    input.resolvedAction && current.resolved_at == null
      ? Math.floor(Date.now() / 1000)
      : current.resolved_at

  db.prepare(
    `UPDATE human_watch_events
       SET status = ?,
           latest_worker_message = ?,
           suggested_action = ?,
           claimed_by_type = ?,
           claimed_by_user_id = ?,
           claimed_by_agent_id = ?,
           claimed_at = ?,
           resolved_action = ?,
           resolved_note = ?,
           resolved_by_type = ?,
           resolved_by_user_id = ?,
           resolved_by_agent_id = ?,
           resolved_at = ?,
           context_json = ?,
           updated_at = unixepoch()
     WHERE id = ? AND workspace_id = ?`,
  ).run(
    nextStatus,
    input.latestWorkerMessage ?? current.latest_worker_message,
    input.suggestedAction ?? current.suggested_action,
    input.claimedByType ?? current.claimed_by_type,
    input.claimedByUserId ?? current.claimed_by_user_id,
    input.claimedByAgentId ?? current.claimed_by_agent_id,
    claimedAt,
    input.resolvedAction ?? current.resolved_action,
    input.resolvedNote ?? current.resolved_note,
    input.resolvedByType ?? current.resolved_by_type,
    input.resolvedByUserId ?? current.resolved_by_user_id,
    input.resolvedByAgentId ?? current.resolved_by_agent_id,
    resolvedAt,
    nextContextWithAudit ? JSON.stringify(nextContextWithAudit) : null,
    id,
    workspaceId,
  )

  const updated = getHumanWatchEvent(id, workspaceId, db)
  if (updated) {
    import('./event-bus').then(({ eventBus }) => eventBus.broadcast('human_watch.event', updated)).catch(() => {})
  }
  return updated
}
