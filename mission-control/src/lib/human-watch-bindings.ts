import type Database from 'better-sqlite3'
import { getDatabase } from './db'
import {
  getAgentLocalSessionKind,
  validateAgentSessionKindBinding,
} from './agent-session-binding'
import {
  getBridgeAgentIndexById,
  getBridgeAgentIndexByLocalId,
} from './sync-agent-index'
import { getSyncedSession } from './sync-sessions'
import { isBridgeClientOnline, requestBridgeClientAgentDetail } from './bridge-server'
import { isHumanWatchAgent, normalizeHumanWatchFramework } from './human-watch-helpers'
import type { HumanWatchBindingMode } from './human-watch-types'

export interface HumanWatchBindingRow {
  id: number
  workspace_id: number
  tenant_id: number | null
  client_id: string
  worker_sync_index_id: number | null
  worker_local_agent_id: number | null
  worker_name: string | null
  steward_sync_index_id: number | null
  steward_local_agent_id: number | null
  steward_name: string | null
  worker_session_id: string | null
  worker_session_kind: string | null
  enabled: number
  mode: HumanWatchBindingMode
  rules_override: string | null
  created_at: number
  updated_at: number
}

export interface ListHumanWatchBindingsFilters {
  workspaceId: number
  clientId?: string
  enabled?: boolean
}

export interface CreateHumanWatchBindingInput {
  workspaceId: number
  tenantId?: number | null
  clientId: string
  workerSyncIndexId?: number | null
  workerLocalAgentId?: number | null
  stewardSyncIndexId?: number | null
  stewardLocalAgentId?: number | null
  workerSessionId?: string | null
  workerSessionKind?: string | null
  enabled?: boolean
  mode?: HumanWatchBindingMode
  rulesOverride?: Record<string, unknown> | null
}

export interface UpdateHumanWatchBindingInput {
  enabled?: boolean
  mode?: HumanWatchBindingMode
  rulesOverride?: Record<string, unknown> | null
  workerSessionId?: string | null
  workerSessionKind?: string | null
  workerSyncIndexId?: number | null
  workerLocalAgentId?: number | null
  stewardSyncIndexId?: number | null
  stewardLocalAgentId?: number | null
}

function dbOr(database?: Database.Database): Database.Database {
  return database ?? getDatabase()
}

function rowToBinding(row: HumanWatchBindingRow): HumanWatchBindingRow {
  return row
}

function resolveWorkerSessionKind(input: {
  clientId: string
  workerSessionId?: string | null
  workerFramework?: string | null
  hint?: string | null
}): 'claude-code' | 'codex-cli' | 'hermes' | null {
  const hinted = String(input.hint || '').trim()
  if (hinted === 'claude-code' || hinted === 'codex-cli' || hinted === 'hermes') return hinted

  const sessionId = String(input.workerSessionId || '').trim()
  if (sessionId) {
    const syncedKind = getSyncedSession(input.clientId, sessionId)?.session_kind
    if (syncedKind === 'claude-code' || syncedKind === 'codex-cli' || syncedKind === 'hermes') {
      return syncedKind
    }
  }

  const frameworkKind = getAgentLocalSessionKind(input.workerFramework)
  return frameworkKind === 'claude-code' || frameworkKind === 'codex-cli' || frameworkKind === 'hermes'
    ? frameworkKind
    : null
}

export function listEnabledBindingsForWorkerSession(
  workspaceId: number,
  workerSessionId: string,
  database?: Database.Database,
): HumanWatchBindingRow[] {
  const sessionId = String(workerSessionId || '').trim()
  if (!sessionId) return []
  const db = dbOr(database)
  return db
    .prepare(
      `SELECT * FROM human_watch_bindings
       WHERE workspace_id = ?
         AND enabled = 1
         AND worker_session_id = ?
       ORDER BY updated_at DESC`,
    )
    .all(workspaceId, sessionId) as HumanWatchBindingRow[]
}

/**
 * Resolve bindings for a transcript update: exact worker_session_id match, then
 * bridge index session_key for the same worker (fixes stale binding session ids).
 */
export function listEnabledBindingsForTranscriptUpdate(
  workspaceId: number,
  sessionId: string,
  database?: Database.Database,
): HumanWatchBindingRow[] {
  const sid = String(sessionId || '').trim()
  if (!sid) return []

  const exact = listEnabledBindingsForWorkerSession(workspaceId, sid, database)
  if (exact.length > 0) return exact

  const all = listAllEnabledHumanWatchBindings(workspaceId, database)
  const matched: HumanWatchBindingRow[] = []
  const seen = new Set<number>()
  for (const binding of all) {
    if (seen.has(binding.id)) continue
    const localId = binding.worker_local_agent_id
    if (localId == null) continue
    const indexRow = getBridgeAgentIndexByLocalId(binding.client_id, localId)
    const indexSession = String(indexRow?.session_key || '').trim()
    if (indexSession && indexSession === sid) {
      matched.push(binding)
      seen.add(binding.id)
    }
  }
  return matched
}

export function listAllEnabledHumanWatchBindings(
  workspaceId = 1,
  database?: Database.Database,
): HumanWatchBindingRow[] {
  const db = dbOr(database)
  return db
    .prepare(
      `SELECT * FROM human_watch_bindings
       WHERE workspace_id = ? AND enabled = 1 AND worker_session_id IS NOT NULL AND worker_session_id != ''
       ORDER BY updated_at DESC`,
    )
    .all(workspaceId) as HumanWatchBindingRow[]
}

export function listHumanWatchBindings(
  filters: ListHumanWatchBindingsFilters,
  database?: Database.Database,
): HumanWatchBindingRow[] {
  const db = dbOr(database)
  const clauses = ['workspace_id = ?']
  const params: unknown[] = [filters.workspaceId]

  if (filters.clientId) {
    clauses.push('client_id = ?')
    params.push(filters.clientId)
  }
  if (filters.enabled != null) {
    clauses.push('enabled = ?')
    params.push(filters.enabled ? 1 : 0)
  }

  return db
    .prepare(
      `SELECT * FROM human_watch_bindings
       WHERE ${clauses.join(' AND ')}
       ORDER BY updated_at DESC, id DESC`,
    )
    .all(...params) as HumanWatchBindingRow[]
}

export function getHumanWatchBinding(
  id: number,
  workspaceId: number,
  database?: Database.Database,
): HumanWatchBindingRow | null {
  const db = dbOr(database)
  const row = db
    .prepare(`SELECT * FROM human_watch_bindings WHERE id = ? AND workspace_id = ? LIMIT 1`)
    .get(id, workspaceId) as HumanWatchBindingRow | undefined
  return row ? rowToBinding(row) : null
}

type ResolvedBindingAgent = {
  syncIndexId: number | null
  localAgentId: number
  name: string
  framework: string | null
  role: string
  sessionKey: string | null
}

async function resolveBindingAgent(input: {
  clientId: string
  syncIndexId?: number | null
  localAgentId?: number | null
  label: 'worker' | 'steward'
}): Promise<ResolvedBindingAgent | { error: string; status: number }> {
  const clientId = input.clientId.trim()
  if (!clientId) {
    return { error: 'client_id is required', status: 400 }
  }

  let indexRow =
    input.syncIndexId != null
      ? getBridgeAgentIndexById(input.syncIndexId)
      : undefined

  if (indexRow && indexRow.client_id !== clientId) {
    return { error: `${input.label} does not belong to client_id`, status: 400 }
  }

  const localAgentId =
    input.localAgentId ??
    indexRow?.local_agent_id ??
    null

  if (!Number.isFinite(localAgentId)) {
    return { error: `${input.label} reference is required`, status: 400 }
  }

  if (!indexRow) {
    indexRow = getBridgeAgentIndexByLocalId(clientId, localAgentId as number)
  }

  if (!indexRow || indexRow.client_id !== clientId) {
    if (isBridgeClientOnline(clientId)) {
      try {
        const detail = await requestBridgeClientAgentDetail({
          clientId,
          localAgentId: localAgentId as number,
        })
        const agent = detail.agent
        if (agent) {
          const role = String(agent.role || '')
          const framework =
            typeof agent.framework === 'string' ? agent.framework : null
          return {
            syncIndexId: null,
            localAgentId: localAgentId as number,
            name: String(agent.name || '').trim() || `${input.label}-${localAgentId}`,
            framework,
            role,
            sessionKey:
              typeof agent.session_key === 'string' ? agent.session_key : null,
          }
        }
      } catch {
        /* fall through to 404 */
      }
    }
    return { error: `${input.label} not found in bridge agent index`, status: 404 }
  }

  let sessionKey: string | null = null
  let role = indexRow.role
  let framework = indexRow.framework

  if (isBridgeClientOnline(clientId)) {
    try {
      const detail = await requestBridgeClientAgentDetail({
        clientId,
        localAgentId: indexRow.local_agent_id,
      })
      const agent = detail.agent
      if (agent) {
        role = String(agent.role || role)
        framework =
          typeof agent.framework === 'string' ? agent.framework : framework
        sessionKey =
          typeof agent.session_key === 'string' ? agent.session_key : null
      }
    } catch {
      // Index row is enough for framework validation when bridge detail fails.
    }
  }

  return {
    syncIndexId: indexRow.id,
    localAgentId: indexRow.local_agent_id,
    name: indexRow.remote_name || indexRow.original_name,
    framework,
    role,
    sessionKey,
  }
}

export async function validateHumanWatchBindingAgents(input: {
  clientId: string
  workerSyncIndexId?: number | null
  workerLocalAgentId?: number | null
  stewardSyncIndexId?: number | null
  stewardLocalAgentId?: number | null
}): Promise<
  | {
      ok: true
      worker: ResolvedBindingAgent
      steward: ResolvedBindingAgent
    }
  | { ok: false; error: string; status: number }
> {
  if (!isBridgeClientOnline(input.clientId)) {
    return { ok: false, error: 'Bridge client is offline', status: 503 }
  }

  const worker = await resolveBindingAgent({
    clientId: input.clientId,
    syncIndexId: input.workerSyncIndexId,
    localAgentId: input.workerLocalAgentId,
    label: 'worker',
  })
  if ('error' in worker) return { ok: false, error: worker.error, status: worker.status }

  const steward = await resolveBindingAgent({
    clientId: input.clientId,
    syncIndexId: input.stewardSyncIndexId,
    localAgentId: input.stewardLocalAgentId,
    label: 'steward',
  })
  if ('error' in steward) return { ok: false, error: steward.error, status: steward.status }

  if (!isHumanWatchAgent({ role: steward.role })) {
    try {
      const detail = await requestBridgeClientAgentDetail({
        clientId: input.clientId,
        localAgentId: steward.localAgentId,
      })
      if (!isHumanWatchAgent({
        role: typeof detail.agent?.role === 'string' ? detail.agent.role : steward.role,
        config: detail.agent?.config,
      })) {
        return { ok: false, error: 'Steward must be a human-watch agent', status: 400 }
      }
    } catch {
      return { ok: false, error: 'Steward must be a human-watch agent', status: 400 }
    }
  }

  const workerKind = normalizeHumanWatchFramework(worker.framework)
  const stewardKind = normalizeHumanWatchFramework(steward.framework)
  const bindingCheck = validateAgentSessionKindBinding(
    steward.framework,
    workerKind,
  )
  if (!bindingCheck.ok || workerKind !== stewardKind) {
    return {
      ok: false,
      error: bindingCheck.ok
        ? 'Worker and steward framework must match'
        : bindingCheck.message,
      status: 400,
    }
  }

  if (
    worker.sessionKey &&
    steward.sessionKey &&
    worker.sessionKey === steward.sessionKey
  ) {
    return {
      ok: false,
      error: 'Worker and steward cannot share the same session_key',
      status: 400,
    }
  }

  if (!getAgentLocalSessionKind(worker.framework)) {
    return { ok: false, error: 'Worker framework is not supported for human watch', status: 400 }
  }

  return { ok: true, worker, steward }
}

export async function createHumanWatchBinding(
  input: CreateHumanWatchBindingInput,
  database?: Database.Database,
): Promise<HumanWatchBindingRow | { error: string; status: number }> {
  const validated = await validateHumanWatchBindingAgents({
    clientId: input.clientId,
    workerSyncIndexId: input.workerSyncIndexId,
    workerLocalAgentId: input.workerLocalAgentId,
    stewardSyncIndexId: input.stewardSyncIndexId,
    stewardLocalAgentId: input.stewardLocalAgentId,
  })
  if (!validated.ok) return validated

  const db = dbOr(database)
  const clientOwner = db.prepare(`SELECT workspace_id FROM sync_clients WHERE client_id = ? LIMIT 1`)
    .get(input.clientId) as { workspace_id?: number } | undefined
  if (clientOwner && clientOwner.workspace_id !== input.workspaceId) {
    return { error: 'client_id does not belong to workspace', status: 400 }
  }
  const workspaceOwner = db.prepare(`SELECT tenant_id FROM workspaces WHERE id = ? LIMIT 1`)
    .get(input.workspaceId) as { tenant_id?: number } | undefined
  if (input.tenantId != null && workspaceOwner && workspaceOwner.tenant_id !== input.tenantId) {
    return { error: 'workspace does not belong to tenant', status: 400 }
  }
  const now = Math.floor(Date.now() / 1000)
  const enabled = input.enabled !== false ? 1 : 0
  const mode = input.mode || 'auto_send'
  const rulesOverride =
    input.rulesOverride != null ? JSON.stringify(input.rulesOverride) : null
  const workerSessionId = input.workerSessionId?.trim() || validated.worker.sessionKey
  const workerSessionKind = resolveWorkerSessionKind({
    clientId: input.clientId,
    workerSessionId,
    workerFramework: validated.worker.framework,
    hint: input.workerSessionKind,
  })

  try {
    const result = db
      .prepare(
        `INSERT INTO human_watch_bindings (
          workspace_id, tenant_id, client_id,
          worker_sync_index_id, worker_local_agent_id, worker_name,
          steward_sync_index_id, steward_local_agent_id, steward_name,
          worker_session_id, worker_session_kind, enabled, mode, rules_override,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.workspaceId,
        input.tenantId ?? null,
        input.clientId,
        validated.worker.syncIndexId,
        validated.worker.localAgentId,
        validated.worker.name,
        validated.steward.syncIndexId,
        validated.steward.localAgentId,
        validated.steward.name,
        workerSessionId,
        workerSessionKind,
        enabled,
        mode,
        rulesOverride,
        now,
        now,
      )

    const row = getHumanWatchBinding(result.lastInsertRowid as number, input.workspaceId, db)
    if (!row) return { error: 'Failed to load created binding', status: 500 }
    return row
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('UNIQUE constraint')) {
      return { error: 'A binding already exists for this worker on this client', status: 409 }
    }
    throw err
  }
}

export function updateHumanWatchBinding(
  id: number,
  workspaceId: number,
  patch: UpdateHumanWatchBindingInput,
  database?: Database.Database,
): HumanWatchBindingRow | null {
  const db = dbOr(database)
  const existing = getHumanWatchBinding(id, workspaceId, db)
  if (!existing) return null

  const now = Math.floor(Date.now() / 1000)
  const enabled = patch.enabled != null ? (patch.enabled ? 1 : 0) : existing.enabled
  const mode = patch.mode ?? existing.mode
  const workerSessionId =
    patch.workerSessionId !== undefined
      ? patch.workerSessionId
      : existing.worker_session_id
  const workerSessionKind = resolveWorkerSessionKind({
    clientId: existing.client_id,
    workerSessionId,
    workerFramework: getBridgeAgentIndexByLocalId(existing.client_id, existing.worker_local_agent_id ?? -1)?.framework,
    hint: patch.workerSessionKind ?? existing.worker_session_kind,
  })
  const rulesOverride =
    patch.rulesOverride !== undefined
      ? patch.rulesOverride
        ? JSON.stringify(patch.rulesOverride)
        : null
      : existing.rules_override

  db.prepare(
    `UPDATE human_watch_bindings
     SET enabled = ?, mode = ?, worker_session_id = ?, worker_session_kind = ?, rules_override = ?, updated_at = ?
     WHERE id = ? AND workspace_id = ?`,
  ).run(enabled, mode, workerSessionId, workerSessionKind, rulesOverride, now, id, workspaceId)

  return getHumanWatchBinding(id, workspaceId, db)
}

/** Reassign worker/steward or patch flags; validates agents when endpoints change. */
export async function patchHumanWatchBinding(
  id: number,
  workspaceId: number,
  patch: UpdateHumanWatchBindingInput,
  database?: Database.Database,
): Promise<HumanWatchBindingRow | { error: string; status: number } | null> {
  const db = dbOr(database)
  const existing = getHumanWatchBinding(id, workspaceId, db)
  if (!existing) return null

  const reassignWorker =
    patch.workerLocalAgentId != null ||
    patch.workerSyncIndexId != null
  const reassignSteward =
    patch.stewardLocalAgentId != null ||
    patch.stewardSyncIndexId != null

  if (reassignWorker || reassignSteward) {
    const validated = await validateHumanWatchBindingAgents({
      clientId: existing.client_id,
      workerSyncIndexId:
        patch.workerSyncIndexId !== undefined
          ? patch.workerSyncIndexId
          : existing.worker_sync_index_id,
      workerLocalAgentId:
        patch.workerLocalAgentId !== undefined
          ? patch.workerLocalAgentId
          : existing.worker_local_agent_id,
      stewardSyncIndexId:
        patch.stewardSyncIndexId !== undefined
          ? patch.stewardSyncIndexId
          : existing.steward_sync_index_id,
      stewardLocalAgentId:
        patch.stewardLocalAgentId !== undefined
          ? patch.stewardLocalAgentId
          : existing.steward_local_agent_id,
    })
    if (!validated.ok) return validated

    const now = Math.floor(Date.now() / 1000)
    const enabled = patch.enabled != null ? (patch.enabled ? 1 : 0) : existing.enabled
    const mode = patch.mode ?? existing.mode
    const workerSessionId =
      patch.workerSessionId !== undefined
        ? patch.workerSessionId
        : validated.worker.sessionKey ?? existing.worker_session_id
    const workerSessionKind = resolveWorkerSessionKind({
      clientId: existing.client_id,
      workerSessionId,
      workerFramework: validated.worker.framework,
      hint: patch.workerSessionKind ?? existing.worker_session_kind,
    })
    const rulesOverride =
      patch.rulesOverride !== undefined
        ? patch.rulesOverride
          ? JSON.stringify(patch.rulesOverride)
          : null
        : existing.rules_override

    db.prepare(
      `UPDATE human_watch_bindings SET
        worker_sync_index_id = ?, worker_local_agent_id = ?, worker_name = ?,
        steward_sync_index_id = ?, steward_local_agent_id = ?, steward_name = ?,
        worker_session_id = ?, worker_session_kind = ?, enabled = ?, mode = ?, rules_override = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?`,
    ).run(
      validated.worker.syncIndexId,
      validated.worker.localAgentId,
      validated.worker.name,
      validated.steward.syncIndexId,
      validated.steward.localAgentId,
      validated.steward.name,
      workerSessionId,
      workerSessionKind,
      enabled,
      mode,
      rulesOverride,
      now,
      id,
      workspaceId,
    )

    return getHumanWatchBinding(id, workspaceId, db)
  }

  const updated = updateHumanWatchBinding(id, workspaceId, patch, db)
  return updated
}

export function deleteHumanWatchBinding(
  id: number,
  workspaceId: number,
  database?: Database.Database,
): boolean {
  const db = dbOr(database)
  const result = db
    .prepare(`DELETE FROM human_watch_bindings WHERE id = ? AND workspace_id = ?`)
    .run(id, workspaceId)
  return result.changes > 0
}

export function disableHumanWatchBinding(
  id: number,
  workspaceId: number,
  database?: Database.Database,
): boolean {
  const db = dbOr(database)
  const result = db
    .prepare(
      `UPDATE human_watch_bindings
       SET enabled = 0, updated_at = unixepoch()
       WHERE id = ? AND workspace_id = ? AND enabled = 1`,
    )
    .run(id, workspaceId)
  return result.changes > 0
}

export function deleteHumanWatchBindingsForSteward(
  workspaceId: number,
  clientId: string,
  stewardLocalAgentId: number,
  database?: Database.Database,
): number {
  const db = dbOr(database)
  const result = db
    .prepare(
      `DELETE FROM human_watch_bindings
       WHERE workspace_id = ? AND client_id = ? AND steward_local_agent_id = ?`,
    )
    .run(workspaceId, clientId, stewardLocalAgentId)
  return result.changes
}

export function deleteHumanWatchBindingsForWorker(
  workspaceId: number,
  clientId: string,
  workerLocalAgentId: number,
  database?: Database.Database,
): number {
  const db = dbOr(database)
  const result = db
    .prepare(
      `DELETE FROM human_watch_bindings
       WHERE workspace_id = ? AND client_id = ? AND worker_local_agent_id = ?`,
    )
    .run(workspaceId, clientId, workerLocalAgentId)
  return result.changes
}

/** Keep binding.worker_session_id aligned with bridge index session_key after edge sync. */
export function syncHumanWatchBindingSessionIds(
  clientId: string,
  workspaceId = 1,
  database?: Database.Database,
): number {
  const cid = clientId.trim()
  if (!cid) return 0
  const db = dbOr(database)
  const now = Math.floor(Date.now() / 1000)
  const bindings = db
    .prepare(
      `SELECT id, worker_local_agent_id, worker_session_id, worker_session_kind
       FROM human_watch_bindings
       WHERE workspace_id = ? AND client_id = ? AND enabled = 1 AND worker_local_agent_id IS NOT NULL`,
    )
    .all(workspaceId, cid) as Array<{
    id: number
    worker_local_agent_id: number
    worker_session_id: string | null
    worker_session_kind: string | null
  }>

  const update = db.prepare(
    `UPDATE human_watch_bindings SET worker_session_id = ?, worker_session_kind = ?, updated_at = ? WHERE id = ?`,
  )
  let updated = 0
  for (const row of bindings) {
    const indexRow = getBridgeAgentIndexByLocalId(cid, row.worker_local_agent_id)
    const sessionKey = String(indexRow?.session_key || '').trim()
    if (!sessionKey) continue
    const sessionKind = resolveWorkerSessionKind({
      clientId: cid,
      workerSessionId: sessionKey,
      workerFramework: indexRow?.framework,
      hint: row.worker_session_kind,
    })
    if (sessionKey === row.worker_session_id && sessionKind === row.worker_session_kind) continue
    update.run(sessionKey, sessionKind, now, row.id)
    updated++
  }
  return updated
}
