import type Database from 'better-sqlite3'
import { getDatabase } from './db'
import { edgeUpstreamFetch, formatUpstreamFetchError } from './edge-upstream-fetch'
import { getRemoteUpstreamConfig } from './remote-server-bridge'
import {
  enqueueLocalSessionPrompt,
  isLocalSessionKind,
  type LocalSessionKind,
} from './local-session-executor'
import { runStewardJudgeOnEdge } from './human-watch-judge'
import { readLocalSessionTranscriptPage, type LocalSessionTranscriptKind } from './session-transcript'
import { decidePermissionRequest, type PermissionDeciderType } from './permission-requests'

export type LocalMailboxAction = 'ack' | 'fail' | 'permission_decision_sync'
export type LocalMailboxStatus = 'pending' | 'processing' | 'completed' | 'failed'

export interface LocalInboxRow {
  message_id: string
  client_id: string
  type: string
  status: LocalMailboxStatus
  idempotency_key: string
  serial_key: string | null
  payload_json: string
  result_json: string | null
  lease_owner: string | null
  lease_expires_at: number | null
  received_at: number
  started_at: number | null
  completed_at: number | null
  last_error: string | null
}

export interface LocalOutboxRow {
  id: number
  message_id: string
  action: LocalMailboxAction
  payload_json: string
  status: 'pending' | 'sent' | 'failed'
  attempt_count: number
  next_attempt_at: number | null
  created_at: number
  sent_at: number | null
  last_error: string | null
}

export interface RemoteMessage {
  id: string
  client_id: string
  type: string
  idempotency_key: string
  session_ref?: {
    session_id?: string
    session_kind?: string
    serial_key?: string | null
  } | null
  payload: Record<string, unknown>
  lease_owner?: string | null
  lease_expires_at?: number | null
}

export interface LocalMessageHandlerResult {
  ok: boolean
  result?: Record<string, unknown>
  errorCode?: string
  errorMessage?: string
  retryable?: boolean
}

export type LocalMessageHandler = (message: {
  id: string
  clientId: string
  type: string
  payload: Record<string, unknown>
}) => Promise<LocalMessageHandlerResult> | LocalMessageHandlerResult

const handlers = new Map<string, LocalMessageHandler>()
const activeSerialKeys = new Set<string>()

export function registerLocalMessageHandler(type: string, handler: LocalMessageHandler): void {
  const key = type.trim()
  if (!key) throw new Error('message type is required')
  handlers.set(key, handler)
}

function dbOr(database?: Database.Database): Database.Database {
  return database ?? getDatabase()
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function getSetting(db: Database.Database, key: string): string {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value?: string } | undefined
  return typeof row?.value === 'string' ? row.value.trim() : ''
}

function getClientId(db: Database.Database): string {
  return getSetting(db, 'device.client_id') || 'mc-node-static'
}

function getGatewayToken(db: Database.Database): string {
  return getSetting(db, 'gateway.token') || getSetting(db, 'edge.enroll_token')
}

function jsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function textFromTranscriptMessage(message: { role: string; parts: Array<{ type: string; text?: string }> }): string {
  return message.parts
    .map((part) => (part.type === 'text' && part.text ? part.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim()
}

function buildAssistJudgePrompt(payload: Record<string, unknown>): string {
  const prompt = String(payload.prompt || '').trim()
  const sessionId = String(payload.worker_session_id || '').trim()
  const kind = String(payload.session_kind || '').trim()
  let transcriptSummary = ''
  if (sessionId && isTranscriptKind(kind)) {
    try {
      const page = readLocalSessionTranscriptPage(kind, sessionId, { limit: 24 })
      transcriptSummary = page.messages
        .slice(-12)
        .map((message) => {
          const text = textFromTranscriptMessage(message)
          return text ? `${message.role}: ${text.slice(0, 1200)}` : ''
        })
        .filter(Boolean)
        .join('\n\n')
        .slice(0, 12000)
    } catch {
      transcriptSummary = ''
    }
  }

  return [
    '你是人工值守智能体。请根据 Worker 当前会话和 Worker 主动求助内容，生成一条可以直接发回 Worker 的中文回复。',
    '要求：只输出要发给 Worker 的回复，不要解释你的推理过程。',
    '',
    'Worker 主动求助：',
    prompt || '(未提供)',
    '',
    transcriptSummary ? `Worker 最近会话：\n${transcriptSummary}` : 'Worker 最近会话：无法读取，按主动求助内容回复。',
  ].join('\n')
}

function isTranscriptKind(value: unknown): value is LocalSessionTranscriptKind {
  return value === 'claude-code' || value === 'codex-cli' || value === 'hermes'
}

async function handleHumanWatchAssistMessage(message: {
  id: string
  clientId: string
  type: string
  payload: Record<string, unknown>
}): Promise<LocalMessageHandlerResult> {
  const payload = message.payload
  const stewardLocalAgentId = Number(payload.steward_local_agent_id)
  if (!Number.isFinite(stewardLocalAgentId) || stewardLocalAgentId <= 0) {
    return {
      ok: false,
      errorCode: 'STEWARD_AGENT_REQUIRED',
      errorMessage: 'steward_local_agent_id is required',
      retryable: false,
    }
  }

  const sessionId = String(payload.worker_session_id || '').trim()
  const sessionKind = String(payload.session_kind || '').trim()
  if (!sessionId || !isLocalSessionKind(sessionKind)) {
    return {
      ok: false,
      errorCode: 'WORKER_SESSION_REQUIRED',
      errorMessage: 'worker_session_id and valid session_kind are required',
      retryable: false,
    }
  }

  const judgePrompt = buildAssistJudgePrompt(payload)
  const judge = await runStewardJudgeOnEdge(stewardLocalAgentId, judgePrompt)
  const reply = String(judge.reply || '').trim()
  if (!reply) {
    return {
      ok: false,
      errorCode: 'STEWARD_EMPTY_REPLY',
      errorMessage: 'Steward judge returned empty reply',
      retryable: true,
    }
  }

  enqueueLocalSessionPrompt(sessionKind as LocalSessionKind, sessionId, reply, {
    workerSessionId: sessionId,
    sessionKind: sessionKind as LocalSessionKind,
  })

  return {
    ok: true,
    result: {
      delivered: true,
      steward_reply: reply,
      steward_session_id: judge.sessionId,
    },
  }
}

function handleSessionContinueMessage(message: {
  id: string
  clientId: string
  type: string
  payload: Record<string, unknown>
}): LocalMessageHandlerResult {
  const sessionId = String(message.payload.session_id || message.payload.worker_session_id || '').trim()
  const sessionKind = String(message.payload.session_kind || '').trim()
  const content = String(message.payload.content || message.payload.prompt || '').trim()
  const workingDirectory = typeof message.payload.working_directory === 'string'
    ? message.payload.working_directory.trim()
    : ''
  const permissionMode = typeof message.payload.permission_mode === 'string'
    ? message.payload.permission_mode.trim()
    : ''
  const localPermissionMode = permissionMode === 'standard' || permissionMode === 'full'
    ? permissionMode
    : undefined
  if (!sessionId || !isLocalSessionKind(sessionKind)) {
    return {
      ok: false,
      errorCode: 'SESSION_CONTINUE_TARGET_REQUIRED',
      errorMessage: 'session_id and valid session_kind are required',
      retryable: false,
    }
  }
  if (!content) {
    return {
      ok: false,
      errorCode: 'SESSION_CONTINUE_CONTENT_REQUIRED',
      errorMessage: 'content is required',
      retryable: false,
    }
  }

  enqueueLocalSessionPrompt(sessionKind as LocalSessionKind, sessionId, content, {
    workerSessionId: sessionId,
    sessionKind: sessionKind as LocalSessionKind,
    workingDirectory: workingDirectory || null,
    permissionMode: localPermissionMode,
  })

  return {
    ok: true,
    result: {
      accepted: true,
      delivered: true,
      session_id: sessionId,
      session_kind: sessionKind,
    },
  }
}

function normalizePermissionDeciderType(value: unknown): PermissionDeciderType {
  const raw = String(value || 'steward_agent').trim()
  return raw === 'human_user' || raw === 'human_external' || raw === 'steward_agent' || raw === 'system'
    ? raw
    : 'steward_agent'
}

function handlePermissionDecisionMessage(message: {
  id: string
  clientId: string
  type: string
  payload: Record<string, unknown>
}): LocalMessageHandlerResult {
  const requestId = String(message.payload.request_id || message.payload.requestId || '').trim()
  const optionId = String(message.payload.option_id || message.payload.optionId || '').trim()
  if (!requestId || !optionId) {
    return {
      ok: false,
      errorCode: 'PERMISSION_DECISION_REQUIRED',
      errorMessage: 'request_id and option_id are required',
      retryable: false,
    }
  }

  const decided = decidePermissionRequest({
    requestId,
    workspaceId: Number(message.payload.workspace_id) || 1,
    optionId,
    reason: typeof message.payload.reason === 'string' ? message.payload.reason : null,
    deciderType: normalizePermissionDeciderType(message.payload.decider_type || message.payload.deciderType),
    deciderUserId: Number.isFinite(Number(message.payload.decider_user_id))
      ? Number(message.payload.decider_user_id)
      : null,
    deciderAgentId:
      typeof message.payload.decider_agent_id === 'string'
        ? message.payload.decider_agent_id
        : typeof message.payload.deciderAgentId === 'string'
          ? message.payload.deciderAgentId
          : null,
    decisionSource: typeof message.payload.decision_source === 'string'
      ? message.payload.decision_source
      : 'reliable_mailbox',
    idempotencyKey:
      typeof message.payload.idempotency_key === 'string'
        ? message.payload.idempotency_key
        : `mailbox:${message.id}`,
  })

  return {
    ok: true,
    result: {
      request_id: decided.id,
      status: decided.status,
      selected_option_id: decided.selected_option_id,
    },
  }
}

function upsertInboxMessage(db: Database.Database, message: RemoteMessage): boolean {
  const serialKey =
    typeof message.session_ref?.serial_key === 'string' && message.session_ref.serial_key.trim()
      ? message.session_ref.serial_key.trim()
      : message.session_ref?.session_id && message.session_ref?.session_kind
        ? `${message.client_id}:${message.session_ref.session_kind}:${message.session_ref.session_id}`
        : null
  const result = db.prepare(`
    INSERT INTO local_message_inbox (
      message_id, client_id, type, status, idempotency_key,
      serial_key, payload_json, lease_owner, lease_expires_at, received_at
    ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(message_id) DO NOTHING
  `).run(
    message.id,
    message.client_id,
    message.type,
    message.idempotency_key,
    serialKey,
    JSON.stringify(message.payload ?? {}),
    message.lease_owner ?? null,
    message.lease_expires_at ?? null,
    nowSeconds(),
  )
  return result.changes === 1
}

function getCompletedExecution(db: Database.Database, idempotencyKey: string): { result_json: string | null } | null {
  return db.prepare(`
    SELECT result_json FROM local_message_executions
    WHERE idempotency_key = ? AND status = 'completed'
    LIMIT 1
  `).get(idempotencyKey) as { result_json: string | null } | undefined ?? null
}

function recordExecution(
  db: Database.Database,
  row: LocalInboxRow,
  status: 'completed' | 'failed',
  result: Record<string, unknown>,
) {
  db.prepare(`
    INSERT INTO local_message_executions (
      idempotency_key, message_id, serial_key, type, status, result_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(idempotency_key) DO UPDATE SET
      message_id = excluded.message_id,
      serial_key = excluded.serial_key,
      type = excluded.type,
      status = excluded.status,
      result_json = excluded.result_json,
      updated_at = excluded.updated_at
  `).run(
    row.idempotency_key,
    row.message_id,
    row.serial_key,
    row.type,
    status,
    JSON.stringify(result),
    nowSeconds(),
    nowSeconds(),
  )
}

function enqueueOutbox(
  db: Database.Database,
  messageId: string,
  action: LocalMailboxAction,
  payload: Record<string, unknown>,
) {
  db.prepare(`
    INSERT INTO local_message_outbox (
      message_id, action, payload_json, status, created_at
    ) VALUES (?, ?, ?, 'pending', ?)
  `).run(messageId, action, JSON.stringify(payload), nowSeconds())
}

async function centerRequest(
  db: Database.Database,
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; body: unknown } | { ok: false; error: string; status: number }> {
  const upstream = getRemoteUpstreamConfig()
  if (!upstream.baseUrl) return { ok: false, error: 'gateway.server_url is not configured', status: 503 }
  const token = getGatewayToken(db)
  if (!token) return { ok: false, error: 'gateway.token / edge.enroll_token is not configured', status: 503 }
  const base = upstream.baseUrl.replace(/\/+$/, '')
  try {
    const res = await edgeUpstreamFetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': token,
        'x-edge-enroll-token': token,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    })
    const parsed = await res.json().catch(() => null)
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error:
          parsed && typeof parsed === 'object' && 'error' in parsed
            ? String((parsed as { error?: string }).error)
            : `HTTP ${res.status}`,
      }
    }
    return { ok: true, body: parsed }
  } catch (err) {
    return { ok: false, error: formatUpstreamFetchError(err), status: 502 }
  }
}

export async function pullMailboxMessages(database?: Database.Database): Promise<{
  pulled: number
  error?: string
}> {
  const db = dbOr(database)
  const clientId = getClientId(db)
  const leaseOwner = `local-mailbox-${process.pid}`
  const res = await centerRequest(db, '/api/edge/messages/lease', {
    client_id: clientId,
    lease_owner: leaseOwner,
    lease_seconds: 120,
    limit: 20,
    capabilities: {
      reliable_mailbox: true,
      human_watch_assist_v2: true,
      permission_decision_relay: true,
      serial_session_continue: true,
    },
  })
  if (!res.ok) return { pulled: 0, error: res.error }
  const body = res.body as { messages?: RemoteMessage[] } | null
  const messages = Array.isArray(body?.messages) ? body.messages : []
  let pulled = 0
  db.transaction(() => {
    for (const message of messages) {
      if (message?.id && message.client_id && message.type && message.idempotency_key) {
        if (upsertInboxMessage(db, message)) pulled++
      }
    }
  })()
  return { pulled }
}

export async function processInbox(database?: Database.Database): Promise<{ executed: number; failed: number }> {
  const db = dbOr(database)
  const rows = db.prepare(`
    SELECT * FROM local_message_inbox
    WHERE status IN ('pending', 'processing')
    ORDER BY received_at ASC
    LIMIT 20
  `).all() as LocalInboxRow[]
  let executed = 0
  let failed = 0
  const claimedSerialKeys = new Set<string>()
  for (const row of rows) {
    if (row.serial_key) {
      if (activeSerialKeys.has(row.serial_key) || claimedSerialKeys.has(row.serial_key)) continue
      activeSerialKeys.add(row.serial_key)
      claimedSerialKeys.add(row.serial_key)
    }
    const handler = handlers.get(row.type)
      || (row.type === 'human_watch.assist.requested' ? handleHumanWatchAssistMessage : null)
      || (row.type === 'session.continue.requested' ? handleSessionContinueMessage : null)
      || (row.type === 'permission.decision.requested' ? handlePermissionDecisionMessage : null)
    try {
      const completedExecution = getCompletedExecution(db, row.idempotency_key)
      if (completedExecution) {
        const result = jsonObject(completedExecution.result_json)
        db.transaction(() => {
          db.prepare(`
            UPDATE local_message_inbox
            SET status = 'completed', result_json = ?, completed_at = ?, last_error = NULL
            WHERE message_id = ?
          `).run(JSON.stringify(result), nowSeconds(), row.message_id)
          enqueueOutbox(db, row.message_id, 'ack', { result, duplicate: true })
        })()
        executed++
        continue
      }

      db.prepare(`
        UPDATE local_message_inbox
        SET status = 'processing', started_at = COALESCE(started_at, ?), last_error = NULL
        WHERE message_id = ?
      `).run(nowSeconds(), row.message_id)

      let result: LocalMessageHandlerResult
      try {
        if (!handler) {
          result = {
            ok: false,
            errorCode: 'UNSUPPORTED_MESSAGE_TYPE',
            errorMessage: `Unsupported local mailbox message type: ${row.type}`,
            retryable: false,
          }
        } else {
          result = await handler({
            id: row.message_id,
            clientId: row.client_id,
            type: row.type,
            payload: jsonObject(row.payload_json),
          })
        }
      } catch (err) {
        result = {
          ok: false,
          errorCode: 'LOCAL_HANDLER_ERROR',
          errorMessage: err instanceof Error ? err.message : String(err),
          retryable: true,
        }
      }

      if (result.ok) {
        db.transaction(() => {
          db.prepare(`
            UPDATE local_message_inbox
            SET status = 'completed', result_json = ?, completed_at = ?, last_error = NULL
            WHERE message_id = ?
          `).run(JSON.stringify(result.result ?? {}), nowSeconds(), row.message_id)
          recordExecution(db, row, 'completed', result.result ?? {})
          enqueueOutbox(db, row.message_id, 'ack', { result: result.result ?? {} })
        })()
        executed++
      } else {
        const payload = {
          error_code: result.errorCode || 'LOCAL_HANDLER_FAILED',
          error_message: result.errorMessage || 'Local handler failed',
          retryable: result.retryable !== false,
          result: result.result ?? {},
        }
        db.transaction(() => {
          db.prepare(`
            UPDATE local_message_inbox
            SET status = 'failed', result_json = ?, completed_at = ?, last_error = ?
            WHERE message_id = ?
          `).run(JSON.stringify(payload.result), nowSeconds(), payload.error_message, row.message_id)
          recordExecution(db, row, 'failed', payload)
          enqueueOutbox(db, row.message_id, 'fail', payload)
        })()
        failed++
      }
    } finally {
      if (row.serial_key) activeSerialKeys.delete(row.serial_key)
    }
  }
  return { executed, failed }
}

export async function flushOutbox(database?: Database.Database): Promise<{ sent: number; failed: number; error?: string }> {
  const db = dbOr(database)
  const clientId = getClientId(db)
  const rows = db.prepare(`
    SELECT * FROM local_message_outbox
    WHERE status = 'pending'
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    ORDER BY created_at ASC
    LIMIT 20
  `).all(nowSeconds()) as LocalOutboxRow[]
  let sent = 0
  let failed = 0
  for (const row of rows) {
    const payload = jsonObject(row.payload_json)
    const path =
      row.action === 'ack'
        ? `/api/edge/messages/${encodeURIComponent(row.message_id)}/ack`
        : row.action === 'fail'
          ? `/api/edge/messages/${encodeURIComponent(row.message_id)}/fail`
          : `/api/permission-requests/${encodeURIComponent(String(payload.request_id || payload.requestId || row.message_id))}/decision`
    const body = row.action === 'permission_decision_sync'
      ? {
          client_id: clientId,
          optionId: payload.option_id || payload.optionId,
          reason: payload.reason ?? null,
          deciderType: payload.decider_type || payload.deciderType || 'steward_agent',
          deciderAgentId: payload.decider_agent_id || payload.deciderAgentId || null,
          decisionSource: payload.decision_source || 'edge_outbox',
          idempotencyKey: payload.idempotency_key || payload.idempotencyKey || `edge-decision:${row.message_id}`,
        }
      : { client_id: clientId, ...payload }
    const res = await centerRequest(db, path, body)
    if (res.ok) {
      db.prepare(`UPDATE local_message_outbox SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?`)
        .run(nowSeconds(), row.id)
      sent++
    } else {
      db.prepare(`
        UPDATE local_message_outbox
        SET attempt_count = attempt_count + 1,
            next_attempt_at = ?,
            last_error = ?
        WHERE id = ?
      `).run(nowSeconds() + 30 * Math.max(1, row.attempt_count + 1), res.error, row.id)
      failed++
    }
  }
  return { sent, failed }
}

export function enqueuePermissionDecisionSync(
  input: {
    requestId: string
    optionId: string
    reason?: string | null
    deciderType?: PermissionDeciderType | null
    deciderAgentId?: string | null
    decisionSource?: string | null
    idempotencyKey?: string | null
  },
  database?: Database.Database,
): boolean {
  const requestId = String(input.requestId || '').trim()
  const optionId = String(input.optionId || '').trim()
  if (!requestId || !optionId) return false
  const db = dbOr(database)
  const idempotencyKey = input.idempotencyKey || `permission-decision:${requestId}:${optionId}`
  enqueueOutbox(db, requestId, 'permission_decision_sync', {
    request_id: requestId,
    option_id: optionId,
    reason: input.reason ?? null,
    decider_type: input.deciderType || 'steward_agent',
    decider_agent_id: input.deciderAgentId ?? null,
    decision_source: input.decisionSource || 'edge_outbox',
    idempotency_key: idempotencyKey,
  })
  return true
}

export async function drainLocalMailbox(database?: Database.Database): Promise<{
  pulled: number
  executed: number
  failed: number
  outbox_sent: number
  outbox_failed: number
  pull_error?: string
}> {
  const db = dbOr(database)
  const outboxBefore = await flushOutbox(db)
  const pull = await pullMailboxMessages(db)
  const processed = await processInbox(db)
  const outboxAfter = await flushOutbox(db)
  return {
    pulled: pull.pulled,
    executed: processed.executed,
    failed: processed.failed,
    outbox_sent: outboxBefore.sent + outboxAfter.sent,
    outbox_failed: outboxBefore.failed + outboxAfter.failed,
    pull_error: pull.error,
  }
}

export function getLocalMailboxStatus(database?: Database.Database) {
  const db = dbOr(database)
  const count = (table: string, status: string) => {
    const row = db.prepare(`SELECT COUNT(*) as count FROM ${table} WHERE status = ?`).get(status) as { count: number }
    return row.count
  }
  const lastOutbox = db.prepare(`
    SELECT sent_at, last_error FROM local_message_outbox
    ORDER BY COALESCE(sent_at, created_at) DESC
    LIMIT 1
  `).get() as { sent_at?: number | null; last_error?: string | null } | undefined
  const lastInboxError = db.prepare(`
    SELECT last_error FROM local_message_inbox
    WHERE last_error IS NOT NULL
    ORDER BY COALESCE(completed_at, started_at, received_at) DESC
    LIMIT 1
  `).get() as { last_error?: string | null } | undefined

  return {
    client_id: getClientId(db),
    inbox: {
      pending: count('local_message_inbox', 'pending'),
      processing: count('local_message_inbox', 'processing'),
      completed: count('local_message_inbox', 'completed'),
      failed: count('local_message_inbox', 'failed'),
    },
    outbox: {
      pending: count('local_message_outbox', 'pending'),
      sent: count('local_message_outbox', 'sent'),
      failed: count('local_message_outbox', 'failed'),
    },
    last_ack_at: lastOutbox?.sent_at ?? null,
    last_error: lastInboxError?.last_error || lastOutbox?.last_error || null,
  }
}
