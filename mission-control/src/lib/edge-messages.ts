import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getDatabase } from './db'
import { logHumanWatchIntervention } from './human-watch-audit'
import { updateHumanWatchEvent } from './human-watch-events'

export type EdgeMessageDirection = 'cloud_to_edge' | 'edge_to_cloud'
export type EdgeMessageStatus =
  | 'pending'
  | 'leased'
  | 'completed'
  | 'failed_retryable'
  | 'dead_letter'
  | 'cancelled'

export interface EdgeMessageAgentRef {
  local_agent_id?: number | null
  agent_name?: string | null
  framework?: string | null
}

export interface EdgeMessageSessionRef {
  session_id: string
  session_kind: string
  serial_key?: string | null
}

export interface EdgeMessageRow {
  id: string
  schema_version: number
  workspace_id: number
  tenant_id: number | null
  client_id: string
  direction: EdgeMessageDirection
  type: string
  status: EdgeMessageStatus
  correlation_id: string
  idempotency_key: string
  agent_ref_json: string | null
  session_ref_json: string | null
  payload_json: string
  result_json: string | null
  lease_owner: string | null
  lease_expires_at: number | null
  attempt_count: number
  max_attempts: number
  next_attempt_at: number | null
  last_error_code: string | null
  last_error_message: string | null
  created_at: number
  updated_at: number
  completed_at: number | null
  cancelled_at: number | null
}

export interface EdgeMessageView
  extends Omit<EdgeMessageRow, 'agent_ref_json' | 'session_ref_json' | 'payload_json' | 'result_json'> {
  agent_ref: EdgeMessageAgentRef | null
  session_ref: EdgeMessageSessionRef | null
  payload: Record<string, unknown>
  result: Record<string, unknown> | null
}

export interface CreateEdgeMessageInput {
  id?: string
  workspaceId: number
  tenantId?: number | null
  clientId: string
  direction?: EdgeMessageDirection
  type: string
  correlationId?: string | null
  idempotencyKey: string
  agentRef?: EdgeMessageAgentRef | null
  sessionRef?: EdgeMessageSessionRef | null
  payload: Record<string, unknown>
  maxAttempts?: number | null
  nextAttemptAt?: number | null
}

export interface LeaseEdgeMessagesInput {
  clientId: string
  leaseOwner: string
  limit?: number
  leaseSeconds?: number
  workspaceId?: number | null
  tenantId?: number | null
  types?: string[]
}

export interface AckEdgeMessageInput {
  id: string
  clientId: string
  leaseOwner?: string | null
  result?: Record<string, unknown> | null
}

export interface FailEdgeMessageInput {
  id: string
  clientId: string
  leaseOwner?: string | null
  errorCode: string
  errorMessage: string
  retryable: boolean
  result?: Record<string, unknown> | null
  nextAttemptAt?: number | null
}

export interface CancelEdgeMessageInput {
  id: string
  workspaceId?: number | null
  reason?: string | null
}

export interface ListEdgeMessagesInput {
  workspaceId?: number | null
  tenantId?: number | null
  clientId?: string | null
  status?: EdgeMessageStatus | null
  type?: string | null
  correlationId?: string | null
  limit?: number | null
}

function dbOr(database?: Database.Database): Database.Database {
  return database ?? getDatabase()
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function stringifyNullable(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value)
}

function view(row: EdgeMessageRow): EdgeMessageView {
  return {
    ...row,
    agent_ref: parseObject(row.agent_ref_json) as EdgeMessageAgentRef | null,
    session_ref: parseObject(row.session_ref_json) as EdgeMessageSessionRef | null,
    payload: parseObject(row.payload_json) ?? {},
    result: parseObject(row.result_json),
  }
}

function recordEvent(
  db: Database.Database,
  messageId: string,
  eventType: string,
  fromStatus: string | null,
  toStatus: string | null,
  detail: Record<string, unknown> = {},
) {
  db.prepare(`
    INSERT INTO edge_message_events (
      message_id, event_type, from_status, to_status, detail_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(messageId, eventType, fromStatus, toStatus, JSON.stringify(detail), nowSeconds())
}

function getRow(db: Database.Database, id: string): EdgeMessageRow | null {
  return db.prepare(`SELECT * FROM edge_messages WHERE id = ?`).get(id) as EdgeMessageRow | undefined ?? null
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function logHumanWatchAssistAck(db: Database.Database, row: EdgeMessageRow, result: Record<string, unknown>) {
  if (row.type !== 'human_watch.assist.requested') return
  const payload = parseObject(row.payload_json) ?? {}
  const reply = stringOrNull(result.steward_reply)
  logHumanWatchIntervention({
    workspaceId: row.workspace_id,
    tenantId: row.tenant_id,
    clientId: row.client_id,
    bindingId: numberOrNull(payload.binding_id),
    workerLocalAgentId: numberOrNull(payload.worker_local_agent_id),
    workerName: stringOrNull(payload.worker_name),
    stewardLocalAgentId: numberOrNull(payload.steward_local_agent_id),
    stewardName: stringOrNull(payload.steward_name),
    workerSessionId: stringOrNull(payload.worker_session_id),
    eventType: 'intervention_completed',
    decision: 'auto_send',
    promptPreview: reply,
    outcome: result.delivered === false ? 'failed' : 'success',
    errorMessage: result.delivered === false ? stringOrNull(result.error_message) ?? 'Human-watch assist was not delivered' : null,
    messageId: row.id,
    correlationId: row.correlation_id,
  }, db)
}

function logHumanWatchAssistFail(db: Database.Database, row: EdgeMessageRow, errorMessage: string) {
  if (row.type !== 'human_watch.assist.requested') return
  const payload = parseObject(row.payload_json) ?? {}
  logHumanWatchIntervention({
    workspaceId: row.workspace_id,
    tenantId: row.tenant_id,
    clientId: row.client_id,
    bindingId: numberOrNull(payload.binding_id),
    workerLocalAgentId: numberOrNull(payload.worker_local_agent_id),
    workerName: stringOrNull(payload.worker_name),
    stewardLocalAgentId: numberOrNull(payload.steward_local_agent_id),
    stewardName: stringOrNull(payload.steward_name),
    workerSessionId: stringOrNull(payload.worker_session_id),
    eventType: 'intervention_skipped',
    decision: 'skipped',
    skipReason: 'edge_message_failed',
    errorMessage,
    messageId: row.id,
    correlationId: row.correlation_id,
  }, db)
}

function humanWatchContinuePayload(row: EdgeMessageRow) {
  if (row.type !== 'session.continue.requested') return null
  const payload = parseObject(row.payload_json) ?? {}
  const bindingId = numberOrNull(payload.human_watch_binding_id)
  const fingerprint = stringOrNull(payload.human_watch_fingerprint)
  if (!bindingId || !fingerprint) return null
  return { payload, bindingId, fingerprint }
}

function logHumanWatchContinueAck(db: Database.Database, row: EdgeMessageRow, result: Record<string, unknown>) {
  const context = humanWatchContinuePayload(row)
  if (!context) return
  const { payload, bindingId, fingerprint } = context
  const prompt = stringOrNull(payload.human_watch_prompt)
  logHumanWatchIntervention({
    workspaceId: row.workspace_id,
    tenantId: row.tenant_id,
    clientId: row.client_id,
    bindingId,
    workerLocalAgentId: numberOrNull(payload.worker_local_agent_id),
    workerName: stringOrNull(payload.human_watch_worker_name),
    stewardLocalAgentId: numberOrNull(payload.human_watch_steward_local_agent_id),
    stewardName: stringOrNull(payload.human_watch_steward_name),
    workerSessionId: stringOrNull(payload.session_id),
    eventType: 'intervention_completed',
    decision: 'auto_send',
    rulesHit: payload.human_watch_rules_hit as Record<string, unknown> | undefined,
    fingerprint,
    promptPreview: prompt,
    outcome: result.delivered === false ? 'failed' : 'success',
    errorMessage: result.delivered === false ? stringOrNull(result.error_message) ?? 'Human-watch reply was not delivered' : null,
    messageId: row.id,
    correlationId: row.correlation_id,
  }, db)
  const eventId = stringOrNull(payload.human_watch_event_id)
  if (eventId) {
    updateHumanWatchEvent(eventId, row.workspace_id, {
      status: result.delivered === false ? 'visible' : 'resolved',
      resolvedAction: result.delivered === false ? null : 'send_message_to_worker',
      resolvedNote: prompt,
      resolvedByType: result.delivered === false ? null : 'steward_agent',
      resolvedByAgentId: result.delivered === false ? null : String(numberOrNull(payload.human_watch_steward_local_agent_id) ?? ''),
      contextPatch: {
        message_id: row.id,
        correlation_id: row.correlation_id,
        delivery_status: result.delivered === false ? 'failed' : 'acked',
        delivery_result: result,
      },
    }, db)
  }
}

function logHumanWatchContinueFail(db: Database.Database, row: EdgeMessageRow, errorMessage: string) {
  const context = humanWatchContinuePayload(row)
  if (!context) return
  const { payload, bindingId, fingerprint } = context
  logHumanWatchIntervention({
    workspaceId: row.workspace_id,
    tenantId: row.tenant_id,
    clientId: row.client_id,
    bindingId,
    workerLocalAgentId: numberOrNull(payload.worker_local_agent_id),
    workerName: stringOrNull(payload.human_watch_worker_name),
    stewardLocalAgentId: numberOrNull(payload.human_watch_steward_local_agent_id),
    stewardName: stringOrNull(payload.human_watch_steward_name),
    workerSessionId: stringOrNull(payload.session_id),
    eventType: 'intervention_completed',
    decision: 'auto_send',
    rulesHit: payload.human_watch_rules_hit as Record<string, unknown> | undefined,
    fingerprint,
    promptPreview: stringOrNull(payload.human_watch_prompt),
    outcome: 'failed',
    errorMessage,
    messageId: row.id,
    correlationId: row.correlation_id,
  }, db)
}

function assertLease(row: EdgeMessageRow, leaseOwner?: string | null) {
  if (row.status !== 'leased') {
    throw new Error(`Edge message is ${row.status}`)
  }
  if (leaseOwner && row.lease_owner !== leaseOwner) {
    throw new Error('Edge message lease owner mismatch')
  }
}

function assertClientWorkspaceOwnership(db: Database.Database, clientId: string, workspaceId: number) {
  const client = db.prepare(`SELECT workspace_id FROM sync_clients WHERE client_id = ? LIMIT 1`)
    .get(clientId) as { workspace_id?: number } | undefined
  if (client && client.workspace_id !== workspaceId) {
    throw new Error('Edge client does not belong to message workspace')
  }
}

export function createEdgeMessage(
  input: CreateEdgeMessageInput,
  database?: Database.Database,
): { message: EdgeMessageView; created: boolean; duplicate: boolean } {
  const db = dbOr(database)
  const clientId = input.clientId.trim()
  const type = input.type.trim()
  const idempotencyKey = input.idempotencyKey.trim()
  if (!clientId) throw new Error('clientId is required')
  if (!type) throw new Error('type is required')
  if (!idempotencyKey) throw new Error('idempotencyKey is required')
  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
    throw new Error('payload must be an object')
  }
  assertClientWorkspaceOwnership(db, clientId, input.workspaceId)

  const existing = db.prepare(`
    SELECT * FROM edge_messages
    WHERE tenant_id IS ? AND client_id = ? AND idempotency_key = ?
    LIMIT 1
  `).get(input.tenantId ?? null, clientId, idempotencyKey) as EdgeMessageRow | undefined
  if (existing) return { message: view(existing), created: false, duplicate: true }

  const now = nowSeconds()
  const id = input.id || randomUUID()
  const correlationId = (input.correlationId || '').trim() || id
  const maxAttempts = Math.max(1, Math.floor(input.maxAttempts ?? 5))

  db.transaction(() => {
    db.prepare(`
      INSERT INTO edge_messages (
        id, schema_version, workspace_id, tenant_id, client_id,
        direction, type, status, correlation_id, idempotency_key,
        agent_ref_json, session_ref_json, payload_json,
        attempt_count, max_attempts, next_attempt_at,
        created_at, updated_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    `).run(
      id,
      input.workspaceId,
      input.tenantId ?? null,
      clientId,
      input.direction ?? 'cloud_to_edge',
      type,
      correlationId,
      idempotencyKey,
      stringifyNullable(input.agentRef ?? null),
      stringifyNullable(input.sessionRef ?? null),
      JSON.stringify(input.payload),
      maxAttempts,
      input.nextAttemptAt ?? null,
      now,
      now,
    )
    recordEvent(db, id, 'created', null, 'pending', { type })
  })()

  const row = getRow(db, id)
  if (!row) throw new Error('Failed to create edge message')
  return { message: view(row), created: true, duplicate: false }
}

function serialKey(row: EdgeMessageRow): string | null {
  const ref = parseObject(row.session_ref_json) as EdgeMessageSessionRef | null
  if (!ref) return null
  if (typeof ref.serial_key === 'string' && ref.serial_key.trim()) return ref.serial_key.trim()
  if (ref.session_id && ref.session_kind) return `${row.client_id}:${ref.session_kind}:${ref.session_id}`
  return null
}

function hasLeasedSerialPeer(db: Database.Database, row: EdgeMessageRow): boolean {
  const key = serialKey(row)
  if (!key) return false
  const leased = db.prepare(`
    SELECT id, session_ref_json FROM edge_messages
    WHERE client_id = ? AND status = 'leased' AND id != ?
  `).all(row.client_id, row.id) as Array<Pick<EdgeMessageRow, 'id' | 'session_ref_json'>>
  return leased.some((peer) => {
    const ref = parseObject(peer.session_ref_json) as EdgeMessageSessionRef | null
    const peerKey = ref?.serial_key || (ref?.session_id && ref?.session_kind ? `${row.client_id}:${ref.session_kind}:${ref.session_id}` : null)
    return peerKey === key
  })
}

export function leaseEdgeMessages(
  input: LeaseEdgeMessagesInput,
  database?: Database.Database,
): EdgeMessageView[] {
  const db = dbOr(database)
  const clientId = input.clientId.trim()
  const leaseOwner = input.leaseOwner.trim()
  if (!clientId) throw new Error('clientId is required')
  if (!leaseOwner) throw new Error('leaseOwner is required')
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 10)), 100)
  const leaseSeconds = Math.min(Math.max(15, Math.floor(input.leaseSeconds ?? 120)), 3600)
  const now = nowSeconds()

  return db.transaction(() => {
    db.prepare(`
      UPDATE edge_messages
      SET status = 'pending',
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = ?
      WHERE client_id = ?
        AND status = 'leased'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= ?
    `).run(now, clientId, now)

    const clauses = [
      `client_id = ?`,
      `direction = 'cloud_to_edge'`,
      `status IN ('pending', 'failed_retryable')`,
      `(next_attempt_at IS NULL OR next_attempt_at <= ?)`,
    ]
    const params: unknown[] = [clientId, now]
    if (input.workspaceId != null) {
      clauses.push(`workspace_id = ?`)
      params.push(input.workspaceId)
    }
    if (input.tenantId != null) {
      clauses.push(`tenant_id IS ?`)
      params.push(input.tenantId)
    }
    if (input.types?.length) {
      clauses.push(`type IN (${input.types.map(() => '?').join(', ')})`)
      params.push(...input.types)
    }

    const candidates = db.prepare(`
      SELECT * FROM edge_messages
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at ASC
      LIMIT ?
    `).all(...params, limit * 3) as EdgeMessageRow[]

    const leased: EdgeMessageView[] = []
    for (const row of candidates) {
      if (leased.length >= limit) break
      if (hasLeasedSerialPeer(db, row)) continue
      const previous = row.status
      const result = db.prepare(`
        UPDATE edge_messages
        SET status = 'leased',
            lease_owner = ?,
            lease_expires_at = ?,
            attempt_count = attempt_count + 1,
            updated_at = ?
        WHERE id = ?
          AND status IN ('pending', 'failed_retryable')
      `).run(leaseOwner, now + leaseSeconds, now, row.id)
      if (result.changes !== 1) continue
      recordEvent(db, row.id, 'leased', previous, 'leased', {
        lease_owner: leaseOwner,
        lease_expires_at: now + leaseSeconds,
      })
      const updated = getRow(db, row.id)
      if (updated) leased.push(view(updated))
    }
    return leased
  })()
}

export function ackEdgeMessage(input: AckEdgeMessageInput, database?: Database.Database): EdgeMessageView {
  const db = dbOr(database)
  const now = nowSeconds()
  return db.transaction(() => {
    const row = getRow(db, input.id)
    if (!row || row.client_id !== input.clientId) throw new Error('Edge message not found')
    assertClientWorkspaceOwnership(db, row.client_id, row.workspace_id)
    assertLease(row, input.leaseOwner)
    db.prepare(`
      UPDATE edge_messages
      SET status = 'completed',
          result_json = ?,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error_code = NULL,
          last_error_message = NULL,
          updated_at = ?,
          completed_at = ?
      WHERE id = ?
    `).run(JSON.stringify(input.result ?? {}), now, now, row.id)
    recordEvent(db, row.id, 'acked', row.status, 'completed', { result: input.result ?? {} })
    logHumanWatchAssistAck(db, row, input.result ?? {})
    logHumanWatchContinueAck(db, row, input.result ?? {})
    const updated = getRow(db, row.id)
    if (!updated) throw new Error('Edge message not found after ack')
    return view(updated)
  })()
}

export function failEdgeMessage(input: FailEdgeMessageInput, database?: Database.Database): EdgeMessageView {
  const db = dbOr(database)
  const now = nowSeconds()
  return db.transaction(() => {
    const row = getRow(db, input.id)
    if (!row || row.client_id !== input.clientId) throw new Error('Edge message not found')
    assertClientWorkspaceOwnership(db, row.client_id, row.workspace_id)
    assertLease(row, input.leaseOwner)
    const canRetry = input.retryable && row.attempt_count < row.max_attempts
    const nextStatus: EdgeMessageStatus = canRetry ? 'failed_retryable' : 'dead_letter'
    const nextAttemptAt = canRetry ? input.nextAttemptAt ?? now + Math.min(3600, 30 * Math.max(1, row.attempt_count)) : null
    db.prepare(`
      UPDATE edge_messages
      SET status = ?,
          result_json = ?,
          lease_owner = NULL,
          lease_expires_at = NULL,
          next_attempt_at = ?,
          last_error_code = ?,
          last_error_message = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      nextStatus,
      JSON.stringify(input.result ?? {}),
      nextAttemptAt,
      input.errorCode,
      input.errorMessage,
      now,
      row.id,
    )
    recordEvent(db, row.id, 'failed', row.status, nextStatus, {
      error_code: input.errorCode,
      error_message: input.errorMessage,
      retryable: input.retryable,
      next_attempt_at: nextAttemptAt,
    })
    logHumanWatchAssistFail(db, row, input.errorMessage)
    if (!canRetry) logHumanWatchContinueFail(db, row, input.errorMessage)
    const updated = getRow(db, row.id)
    if (!updated) throw new Error('Edge message not found after fail')
    return view(updated)
  })()
}

export function cancelEdgeMessage(input: CancelEdgeMessageInput, database?: Database.Database): EdgeMessageView {
  const db = dbOr(database)
  const now = nowSeconds()
  return db.transaction(() => {
    const row = getRow(db, input.id)
    if (!row || (input.workspaceId != null && row.workspace_id !== input.workspaceId)) {
      throw new Error('Edge message not found')
    }
    if (row.status === 'completed') throw new Error('Completed edge message cannot be cancelled')
    db.prepare(`
      UPDATE edge_messages
      SET status = 'cancelled',
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = ?,
          cancelled_at = ?
      WHERE id = ?
    `).run(now, now, row.id)
    recordEvent(db, row.id, 'cancelled', row.status, 'cancelled', { reason: input.reason ?? null })
    const updated = getRow(db, row.id)
    if (!updated) throw new Error('Edge message not found after cancel')
    return view(updated)
  })()
}

export function getEdgeMessage(id: string, database?: Database.Database): EdgeMessageView | null {
  const row = getRow(dbOr(database), id)
  return row ? view(row) : null
}

export function listEdgeMessages(input: ListEdgeMessagesInput = {}, database?: Database.Database): EdgeMessageView[] {
  const db = dbOr(database)
  const clauses: string[] = []
  const params: unknown[] = []
  if (input.workspaceId != null) {
    clauses.push('workspace_id = ?')
    params.push(input.workspaceId)
  }
  if (input.tenantId != null) {
    clauses.push('tenant_id IS ?')
    params.push(input.tenantId)
  }
  if (input.clientId) {
    clauses.push('client_id = ?')
    params.push(input.clientId)
  }
  if (input.status) {
    clauses.push('status = ?')
    params.push(input.status)
  }
  if (input.type) {
    clauses.push('type = ?')
    params.push(input.type)
  }
  if (input.correlationId) {
    clauses.push('correlation_id = ?')
    params.push(input.correlationId)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 50)), 200)
  const rows = db.prepare(`
    SELECT * FROM edge_messages
    ${where}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params, limit) as EdgeMessageRow[]
  return rows.map(view)
}

export function listEdgeMessageEvents(messageId: string, database?: Database.Database) {
  return dbOr(database).prepare(`
    SELECT * FROM edge_message_events
    WHERE message_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(messageId)
}
