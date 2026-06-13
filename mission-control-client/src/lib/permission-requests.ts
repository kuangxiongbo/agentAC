import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getDatabase } from './db'
import { eventBus } from './event-bus'

export type PermissionRequestRisk = 'low' | 'medium' | 'high' | 'critical'
export type PermissionRequestStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled'
export type PermissionDeciderType = 'human_user' | 'steward_agent' | 'system'

export interface PermissionRequestOption {
  id: string
  label: string
  action: 'approve' | 'deny' | 'ask_human'
  description?: string
}

export interface PermissionRequestRow {
  id: string
  workspace_id: number
  tenant_id: number | null
  client_id: string | null
  binding_id: number | null
  worker_sync_index_id: number | null
  worker_local_agent_id: number | null
  worker_name: string | null
  worker_session_id: string | null
  steward_sync_index_id: number | null
  steward_local_agent_id: number | null
  steward_name: string | null
  request_type: string
  title: string
  prompt: string
  risk: PermissionRequestRisk
  status: PermissionRequestStatus
  options_json: string
  context_json: string | null
  selected_option_id: string | null
  decision_reason: string | null
  decider_type: PermissionDeciderType | null
  decider_user_id: number | null
  decider_agent_id: string | null
  decided_at: number | null
  expires_at: number | null
  created_at: number
  updated_at: number
}

export interface PermissionRequestView extends Omit<PermissionRequestRow, 'options_json' | 'context_json'> {
  options: PermissionRequestOption[]
  context: Record<string, unknown> | null
}

export interface CreatePermissionRequestInput {
  id?: string
  workspaceId: number
  tenantId?: number | null
  clientId?: string | null
  bindingId?: number | null
  workerSyncIndexId?: number | null
  workerLocalAgentId?: number | null
  workerName?: string | null
  workerSessionId?: string | null
  stewardSyncIndexId?: number | null
  stewardLocalAgentId?: number | null
  stewardName?: string | null
  requestType: string
  title: string
  prompt: string
  risk?: PermissionRequestRisk
  options: PermissionRequestOption[]
  context?: Record<string, unknown> | null
  expiresAt?: number | null
}

export interface DecidePermissionRequestInput {
  requestId: string
  workspaceId: number
  optionId: string
  reason?: string | null
  deciderType: PermissionDeciderType
  deciderUserId?: number | null
  deciderAgentId?: string | null
}

export interface WaitForPermissionRequestDecisionOptions {
  requestId: string
  workspaceId: number
  timeoutMs?: number
  pollIntervalMs?: number
}

export interface PatchPermissionRequestContextInput {
  requestId: string
  workspaceId: number
  patch: Record<string, unknown>
}

export interface PermissionRequestSnapshotInput extends Omit<CreatePermissionRequestInput, 'options'> {
  status?: PermissionRequestStatus
  options: PermissionRequestOption[]
  selectedOptionId?: string | null
  decisionReason?: string | null
  deciderType?: PermissionDeciderType | null
  deciderUserId?: number | null
  deciderAgentId?: string | null
  decidedAt?: number | null
  createdAt?: number | null
  updatedAt?: number | null
}

function dbOr(database?: Database.Database): Database.Database {
  return database ?? getDatabase()
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function parseOptions(raw: string): PermissionRequestOption[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed as PermissionRequestOption[] : []
  } catch {
    return []
  }
}

function normalizeOptions(options: PermissionRequestOption[]): PermissionRequestOption[] {
  const normalized: PermissionRequestOption[] = []
  const seen = new Set<string>()
  for (const option of options) {
    const id = String(option?.id || '').trim()
    const label = String(option?.label || '').trim()
    const action = option?.action
    if (!id || !label || !['approve', 'deny', 'ask_human'].includes(action)) {
      throw new Error('Each option requires id, label, and action')
    }
    if (seen.has(id)) throw new Error(`Duplicate option id: ${id}`)
    seen.add(id)
    normalized.push({
      id,
      label,
      action,
      description: typeof option.description === 'string' ? option.description : undefined,
    })
  }
  if (normalized.length < 2) throw new Error('At least two decision options are required')
  return normalized
}

function toView(row: PermissionRequestRow): PermissionRequestView {
  const { options_json, context_json, ...rest } = row
  return {
    ...rest,
    options: parseOptions(options_json),
    context: parseJsonObject(context_json),
  }
}

export function createPermissionRequest(
  input: CreatePermissionRequestInput,
  database?: Database.Database,
): PermissionRequestView {
  const db = dbOr(database)
  const id = String(input.id || randomUUID()).trim()
  const requestType = String(input.requestType || '').trim()
  const title = String(input.title || '').trim()
  const prompt = String(input.prompt || '').trim()
  if (!id) throw new Error('id is required')
  if (!requestType) throw new Error('requestType is required')
  if (!title) throw new Error('title is required')
  if (!prompt) throw new Error('prompt is required')

  const risk = input.risk ?? 'medium'
  if (!['low', 'medium', 'high', 'critical'].includes(risk)) {
    throw new Error('risk must be low, medium, high, or critical')
  }
  const options = normalizeOptions(input.options)
  const contextJson = input.context ? JSON.stringify(input.context) : null

  db.prepare(
    `INSERT INTO permission_requests (
      id, workspace_id, tenant_id, client_id, binding_id,
      worker_sync_index_id, worker_local_agent_id, worker_name, worker_session_id,
      steward_sync_index_id, steward_local_agent_id, steward_name,
      request_type, title, prompt, risk, status, options_json, context_json,
      expires_at, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, 'pending', ?, ?,
      ?, unixepoch(), unixepoch()
    )`,
  ).run(
    id,
    input.workspaceId,
    input.tenantId ?? null,
    input.clientId ?? null,
    input.bindingId ?? null,
    input.workerSyncIndexId ?? null,
    input.workerLocalAgentId ?? null,
    input.workerName ?? null,
    input.workerSessionId ?? null,
    input.stewardSyncIndexId ?? null,
    input.stewardLocalAgentId ?? null,
    input.stewardName ?? null,
    requestType,
    title,
    prompt,
    risk,
    JSON.stringify(options),
    contextJson,
    input.expiresAt ?? null,
  )

  const created = getPermissionRequest(id, input.workspaceId, db)
  if (!created) throw new Error('Failed to create permission request')
  eventBus.broadcast('permission.requested', created)
  return created
}

export function upsertPermissionRequestSnapshot(
  input: PermissionRequestSnapshotInput,
  database?: Database.Database,
): PermissionRequestView {
  const db = dbOr(database)
  const id = String(input.id || '').trim()
  const requestType = String(input.requestType || '').trim()
  const title = String(input.title || '').trim()
  const prompt = String(input.prompt || '').trim()
  if (!id) throw new Error('id is required')
  if (!requestType) throw new Error('requestType is required')
  if (!title) throw new Error('title is required')
  if (!prompt) throw new Error('prompt is required')

  const status = input.status ?? 'pending'
  if (!['pending', 'approved', 'denied', 'expired', 'cancelled'].includes(status)) {
    throw new Error('Invalid permission request status')
  }
  const risk = input.risk ?? 'medium'
  if (!['low', 'medium', 'high', 'critical'].includes(risk)) {
    throw new Error('risk must be low, medium, high, or critical')
  }
  const options = normalizeOptions(input.options)
  const now = Math.floor(Date.now() / 1000)

  db.prepare(
    `INSERT INTO permission_requests (
      id, workspace_id, tenant_id, client_id, binding_id,
      worker_sync_index_id, worker_local_agent_id, worker_name, worker_session_id,
      steward_sync_index_id, steward_local_agent_id, steward_name,
      request_type, title, prompt, risk, status, options_json, context_json,
      selected_option_id, decision_reason, decider_type, decider_user_id, decider_agent_id,
      decided_at, expires_at, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      tenant_id = excluded.tenant_id,
      client_id = excluded.client_id,
      binding_id = excluded.binding_id,
      worker_sync_index_id = excluded.worker_sync_index_id,
      worker_local_agent_id = excluded.worker_local_agent_id,
      worker_name = excluded.worker_name,
      worker_session_id = excluded.worker_session_id,
      steward_sync_index_id = excluded.steward_sync_index_id,
      steward_local_agent_id = excluded.steward_local_agent_id,
      steward_name = excluded.steward_name,
      request_type = excluded.request_type,
      title = excluded.title,
      prompt = excluded.prompt,
      risk = excluded.risk,
      status = excluded.status,
      options_json = excluded.options_json,
      context_json = excluded.context_json,
      selected_option_id = excluded.selected_option_id,
      decision_reason = excluded.decision_reason,
      decider_type = excluded.decider_type,
      decider_user_id = excluded.decider_user_id,
      decider_agent_id = excluded.decider_agent_id,
      decided_at = excluded.decided_at,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at`,
  ).run(
    id,
    input.workspaceId,
    input.tenantId ?? null,
    input.clientId ?? null,
    input.bindingId ?? null,
    input.workerSyncIndexId ?? null,
    input.workerLocalAgentId ?? null,
    input.workerName ?? null,
    input.workerSessionId ?? null,
    input.stewardSyncIndexId ?? null,
    input.stewardLocalAgentId ?? null,
    input.stewardName ?? null,
    requestType,
    title,
    prompt,
    risk,
    status,
    JSON.stringify(options),
    input.context ? JSON.stringify(input.context) : null,
    input.selectedOptionId ?? null,
    input.decisionReason ?? null,
    input.deciderType ?? null,
    input.deciderUserId ?? null,
    input.deciderAgentId ?? null,
    input.decidedAt ?? null,
    input.expiresAt ?? null,
    input.createdAt ?? now,
    input.updatedAt ?? now,
  )

  const row = getPermissionRequest(id, input.workspaceId, db)
  if (!row) throw new Error('Failed to upsert permission request snapshot')
  eventBus.broadcast(row.status === 'pending' ? 'permission.requested' : 'permission.decided', row)
  return row
}

export function getPermissionRequest(
  id: string,
  workspaceId: number,
  database?: Database.Database,
): PermissionRequestView | null {
  const db = dbOr(database)
  const row = db
    .prepare(`SELECT * FROM permission_requests WHERE id = ? AND workspace_id = ? LIMIT 1`)
    .get(id, workspaceId) as PermissionRequestRow | undefined
  return row ? toView(row) : null
}

export function listPermissionRequests(
  filters: {
    workspaceId: number
    tenantId?: number
    status?: PermissionRequestStatus
    clientId?: string
    workerLocalAgentId?: number
    stewardLocalAgentId?: number
    limit?: number
  },
  database?: Database.Database,
): PermissionRequestView[] {
  const db = dbOr(database)
  const clauses = ['workspace_id = ?']
  const params: Array<string | number> = [filters.workspaceId]
  if (filters.tenantId != null) {
    clauses.push('tenant_id = ?')
    params.push(filters.tenantId)
  }
  if (filters.status) {
    clauses.push('status = ?')
    params.push(filters.status)
  }
  if (filters.clientId) {
    clauses.push('client_id = ?')
    params.push(filters.clientId)
  }
  if (filters.workerLocalAgentId != null) {
    clauses.push('worker_local_agent_id = ?')
    params.push(filters.workerLocalAgentId)
  }
  if (filters.stewardLocalAgentId != null) {
    clauses.push('steward_local_agent_id = ?')
    params.push(filters.stewardLocalAgentId)
  }
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200)
  params.push(limit)
  return db
    .prepare(
      `SELECT * FROM permission_requests
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(...params)
    .map((row) => toView(row as PermissionRequestRow))
}

export function decidePermissionRequest(
  input: DecidePermissionRequestInput,
  database?: Database.Database,
): PermissionRequestView {
  const db = dbOr(database)
  const before = getPermissionRequest(input.requestId, input.workspaceId, db)
  if (!before) throw new Error('Permission request not found')
  if (before.status === 'pending' && before.expires_at && before.expires_at < Math.floor(Date.now() / 1000)) {
    db.prepare(
      `UPDATE permission_requests
       SET status = 'expired', updated_at = unixepoch()
       WHERE id = ? AND workspace_id = ? AND status = 'pending'`,
    ).run(input.requestId, input.workspaceId)
    eventBus.broadcast('permission.decided', getPermissionRequest(input.requestId, input.workspaceId, db))
    throw new Error('Permission request is expired')
  }

  return db.transaction(() => {
    const current = getPermissionRequest(input.requestId, input.workspaceId, db)
    if (!current) throw new Error('Permission request not found')
    if (current.status !== 'pending') throw new Error(`Permission request is ${current.status}`)

    const option = current.options.find((item) => item.id === input.optionId)
    if (!option) throw new Error('Invalid optionId for permission request')
    if (
      input.deciderType === 'steward_agent'
      && option.action === 'approve'
      && (current.risk === 'high' || current.risk === 'critical')
    ) {
      throw new Error('Steward agent cannot approve high or critical permission requests')
    }
    const status: PermissionRequestStatus = option.action === 'approve' ? 'approved' : 'denied'
    const reason = String(input.reason || '').trim() || null
    const deciderAgentId = input.deciderAgentId ? String(input.deciderAgentId).trim() : null

    db.prepare(
      `INSERT INTO permission_request_decisions (
        request_id, option_id, reason, decider_type, decider_user_id, decider_agent_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, unixepoch())`,
    ).run(
      input.requestId,
      option.id,
      reason,
      input.deciderType,
      input.deciderUserId ?? null,
      deciderAgentId,
    )

    db.prepare(
      `UPDATE permission_requests
       SET status = ?,
           selected_option_id = ?,
           decision_reason = ?,
           decider_type = ?,
           decider_user_id = ?,
           decider_agent_id = ?,
           decided_at = unixepoch(),
           updated_at = unixepoch()
       WHERE id = ? AND workspace_id = ? AND status = 'pending'`,
    ).run(
      status,
      option.id,
      reason,
      input.deciderType,
      input.deciderUserId ?? null,
      deciderAgentId,
      input.requestId,
      input.workspaceId,
    )

    const decided = getPermissionRequest(input.requestId, input.workspaceId, db)
    if (!decided) throw new Error('Permission request disappeared after decision')
    eventBus.broadcast('permission.decided', decided)
    return decided
  })()
}

export function patchPermissionRequestContext(
  input: PatchPermissionRequestContextInput,
  database?: Database.Database,
): PermissionRequestView {
  const db = dbOr(database)
  const current = getPermissionRequest(input.requestId, input.workspaceId, db)
  if (!current) throw new Error('Permission request not found')
  const context = {
    ...(current.context ?? {}),
    ...input.patch,
  }
  db.prepare(
    `UPDATE permission_requests
     SET context_json = ?, updated_at = unixepoch()
     WHERE id = ? AND workspace_id = ?`,
  ).run(JSON.stringify(context), input.requestId, input.workspaceId)
  const updated = getPermissionRequest(input.requestId, input.workspaceId, db)
  if (!updated) throw new Error('Permission request disappeared after context patch')
  eventBus.broadcast('permission.decided', updated)
  return updated
}

export async function waitForPermissionRequestDecision(
  input: WaitForPermissionRequestDecisionOptions,
  database?: Database.Database,
): Promise<PermissionRequestView> {
  const timeoutMs = Math.max(1000, input.timeoutMs ?? 300_000)
  const pollIntervalMs = Math.min(Math.max(input.pollIntervalMs ?? 1000, 250), 10_000)
  const startedAt = Date.now()

  const current = getPermissionRequest(input.requestId, input.workspaceId, database)
  if (!current) throw new Error('Permission request not found')
  if (current.status !== 'pending') return current

  return await new Promise<PermissionRequestView>((resolve, reject) => {
    let settled = false
    let pollTimer: ReturnType<typeof setTimeout> | null = null
    const timeout = setTimeout(() => {
      finish(null, new Error('Timed out waiting for permission decision'))
    }, timeoutMs)

    const finish = (value: PermissionRequestView | null, error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (pollTimer) clearTimeout(pollTimer)
      eventBus.off('server-event', onEvent)
      if (error) reject(error)
      else if (value) resolve(value)
      else reject(new Error('Permission decision wait ended without a result'))
    }

    const check = () => {
      try {
        const next = getPermissionRequest(input.requestId, input.workspaceId, database)
        if (!next) return finish(null, new Error('Permission request not found'))
        if (next.status !== 'pending') return finish(next)
        if (Date.now() - startedAt >= timeoutMs) {
          return finish(null, new Error('Timed out waiting for permission decision'))
        }
        pollTimer = setTimeout(check, pollIntervalMs)
      } catch (err) {
        finish(null, err instanceof Error ? err : new Error('Failed to check permission decision'))
      }
    }

    const onEvent = (event: { type?: string; data?: unknown }) => {
      if (event?.type !== 'permission.decided') return
      const data = event.data as { id?: unknown; workspace_id?: unknown; status?: unknown } | null
      if (String(data?.id || '') !== input.requestId) return
      if (Number(data?.workspace_id) !== input.workspaceId) return
      if (String(data?.status || '') === 'pending') return
      const next = getPermissionRequest(input.requestId, input.workspaceId, database)
      if (next) finish(next)
    }

    eventBus.on('server-event', onEvent)
    pollTimer = setTimeout(check, pollIntervalMs)
  })
}
