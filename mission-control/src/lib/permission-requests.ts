import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getDatabase } from './db'
import { eventBus } from './event-bus'
import { createHumanWatchEvent } from './human-watch-events'
import { listHumanWatchEvents, updateHumanWatchEvent } from './human-watch-events'

export type PermissionRequestRisk = 'low' | 'medium' | 'high' | 'critical'
export type PermissionRequestStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled'
export type PermissionDeciderType = 'human_user' | 'human_external' | 'steward_agent' | 'system'

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
  decisionSource?: string | null
  idempotencyKey?: string | null
}

export interface WorkerHumanReplyInput {
  requestId: string
  workspaceId: number
  clientNodeId?: string | null
  sessionId?: string | null
  messageId?: string | null
  replyText?: string | null
  selectedOptionId: string
  operatorUserId?: number | null
  observedAt?: string | null
  idempotencyKey?: string | null
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

function auditList(context: Record<string, unknown> | null): Array<Record<string, unknown>> {
  const raw = context?.watch_event_audit
  return Array.isArray(raw) ? raw.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item))) : []
}

function appendAudit(
  context: Record<string, unknown> | null,
  eventName: string,
  detail: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...(context ?? {}),
    watch_event_audit: [
      ...auditList(context),
      {
        event_name: eventName,
        created_at: Math.floor(Date.now() / 1000),
        ...detail,
      },
    ],
  }
}

function notificationTargets(context: Record<string, unknown> | null): string[] {
  const watchEvent = context?.watch_event
  const raw = watchEvent && typeof watchEvent === 'object' && !Array.isArray(watchEvent)
    ? (watchEvent as Record<string, unknown>).notification_targets
    : null
  return Array.isArray(raw) ? raw.map((item) => String(item || '').trim()).filter(Boolean) : []
}

function maskNotificationTarget(target: string): string {
  return target
    .replace(/(token=)[^&]+/gi, '$1***')
    .replace(/(key=)[^&]+/gi, '$1***')
    .replace(/(signature=)[^&]+/gi, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1***')
}

function withWatchEventNotifyStatus(
  context: Record<string, unknown>,
  status: 'sent' | 'failed' | 'pending',
): Record<string, unknown> {
  const watchEvent = context.watch_event && typeof context.watch_event === 'object' && !Array.isArray(context.watch_event)
    ? context.watch_event as Record<string, unknown>
    : {}
  return {
    ...context,
    watch_event: {
      ...watchEvent,
      notify_status: status,
      notify_updated_at: Math.floor(Date.now() / 1000),
    },
  }
}

function appendHumanNotificationAudit(
  context: Record<string, unknown> | null,
  detail: Record<string, unknown>,
): Record<string, unknown> {
  const targets = notificationTargets(context)
  if (targets.length === 0) {
    return withWatchEventNotifyStatus(
      appendAudit(context, 'human_notification_failed', {
        ...detail,
        reason: 'notification_targets_missing',
      }),
      'failed',
    )
  }
  return withWatchEventNotifyStatus(
    appendAudit(context, 'human_notification_sent', {
      ...detail,
      targets: targets.map(maskNotificationTarget),
    }),
    'sent',
  )
}

const DANGEROUS_ACTION_PATTERNS: Array<{ key: string; pattern: RegExp }> = [
  { key: 'delete', pattern: /\b(rm\s+-rf|delete|drop|truncate|remove|unlink|删除|清空|销毁)\b/i },
  { key: 'uninstall', pattern: /\b(uninstall|brew\s+uninstall|apt\s+remove|停止关键进程|卸载)\b/i },
  { key: 'overwrite', pattern: /\b(overwrite|replace|覆盖|批量修改|批量重命名)\b/i },
  { key: 'production_change', pattern: /\b(production|prod|deploy|restart|上线|生产|部署|重启)\b/i },
  { key: 'payment', pattern: /\b(payment|pay|purchase|refund|transfer|付款|购买|退款|转账)\b/i },
  { key: 'external_send', pattern: /\b(send email|sms|webhook|notify customer|外发|发送邮件|短信|客户通知)\b/i },
  { key: 'secret_access', pattern: /\b(secret|token|password|certificate|private key|密钥|凭证|密码|证书)\b/i },
  { key: 'privilege_escalation', pattern: /\b(sudo|chmod\s+777|chown|提权|权限提升|关闭安全校验)\b/i },
]

function contextDangerousActionKeys(context: Record<string, unknown> | null): string[] {
  const watchEvent = context?.watch_event
  const explicit = watchEvent && typeof watchEvent === 'object' && !Array.isArray(watchEvent)
    ? (watchEvent as Record<string, unknown>).dangerous_action_keys
    : null
  if (Array.isArray(explicit)) {
    return explicit.map((item) => String(item || '').trim()).filter(Boolean)
  }
  const single = watchEvent && typeof watchEvent === 'object' && !Array.isArray(watchEvent)
    ? (watchEvent as Record<string, unknown>).dangerous_action
    : null
  if (typeof single === 'string' && single.trim()) return [single.trim()]
  return []
}

function detectsDangerousAction(request: PermissionRequestView): string[] {
  const explicit = contextDangerousActionKeys(request.context)
  if (explicit.length > 0) return explicit
  const haystack = [
    request.request_type,
    request.title,
    request.prompt,
    JSON.stringify(request.context ?? {}),
    ...request.options.map((option) => `${option.id} ${option.label} ${option.description ?? ''}`),
  ].join('\n')
  return DANGEROUS_ACTION_PATTERNS.filter(({ pattern }) => pattern.test(haystack)).map(({ key }) => key)
}

export function isDangerousPermissionRequest(request: PermissionRequestView): boolean {
  return detectsDangerousAction(request).length > 0
}

function resolveLinkedWatchEvents(
  requestId: string,
  workspaceId: number,
  database?: Database.Database,
) {
  return listHumanWatchEvents(
    {
      workspaceId,
      permissionRequestId: requestId,
      limit: 20,
    },
    database,
  )
}

function normalizeIdempotencyKey(value: string | null | undefined): string | null {
  const key = String(value || '').trim()
  return key || null
}

function hasDecisionIdempotencyKey(context: Record<string, unknown> | null, key: string | null): boolean {
  if (!key) return false
  return auditList(context).some((item) => item.idempotency_key === key)
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
  const watchEvent = created.context?.watch_event
  const watchEventSource =
    watchEvent && typeof watchEvent === 'object' && !Array.isArray(watchEvent)
      ? String((watchEvent as Record<string, unknown>).source || '').trim()
      : ''
  const summary = [created.title, created.prompt].filter(Boolean).join(' - ').trim()
  createHumanWatchEvent(
    {
      workspaceId: created.workspace_id,
      tenantId: created.tenant_id,
      clientId: created.client_id ?? 'local',
      bindingId: created.binding_id,
      workerSyncIndexId: created.worker_sync_index_id,
      workerLocalAgentId: created.worker_local_agent_id,
      workerName: created.worker_name,
      workerSessionId: created.worker_session_id,
      stewardSyncIndexId: created.steward_sync_index_id,
      stewardLocalAgentId: created.steward_local_agent_id,
      stewardName: created.steward_name,
      permissionRequestId: created.id,
      source: watchEventSource === 'worker_tool' ? 'worker_tool' : 'permission_request',
      status: 'pending',
      priority: created.risk === 'critical' || created.risk === 'high' ? created.risk : 'medium',
      title: created.title,
      summary: summary || created.prompt,
      context: {
        permission_request_id: created.id,
        request_type: created.request_type,
        options: created.options,
        request_risk: created.risk,
        session_kind:
          created.context && typeof created.context === 'object' && !Array.isArray(created.context)
            ? (created.context as Record<string, unknown>).session_kind ?? null
            : null,
        watch_event: created.context?.watch_event ?? null,
      },
      latestWorkerMessage: created.prompt,
      suggestedAction: created.options.some((option) => option.action === 'ask_human')
        ? 'approve_request'
        : 'send_message_to_worker',
      dedupeKey: `permission_request:${created.id}`,
    },
    db,
  )
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
  const beforeOption = before.options.find((item) => item.id === input.optionId)
  if (!beforeOption) throw new Error('Invalid optionId for permission request')
  if (
    before.status === 'pending'
    && input.deciderType === 'steward_agent'
    && beforeOption.action === 'approve'
    && isDangerousPermissionRequest(before)
  ) {
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey)
    const rejectedContext = appendAudit(before.context, 'decision_rejected_by_policy', {
      reason: 'dangerous_action_requires_human',
      option_id: beforeOption.id,
      decider_type: input.deciderType,
      dangerous_action_keys: detectsDangerousAction(before),
      decision_source: input.decisionSource ?? null,
      idempotency_key: idempotencyKey,
    })
    const context = appendHumanNotificationAudit(rejectedContext, {
      request_id: before.id,
      option_id: beforeOption.id,
      dangerous_action_keys: detectsDangerousAction(before),
    })
    db.prepare(
      `UPDATE permission_requests
       SET context_json = ?, updated_at = unixepoch()
       WHERE id = ? AND workspace_id = ? AND status = 'pending'`,
    ).run(JSON.stringify(context), input.requestId, input.workspaceId)
    throw new Error('Steward agent cannot approve dangerous action permission requests')
  }

  return db.transaction(() => {
    const current = getPermissionRequest(input.requestId, input.workspaceId, db)
    if (!current) throw new Error('Permission request not found')
    if (current.status !== 'pending') throw new Error(`Permission request is ${current.status}`)

    const option = current.options.find((item) => item.id === input.optionId)
    if (!option) throw new Error('Invalid optionId for permission request')
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey)
    if (hasDecisionIdempotencyKey(current.context, idempotencyKey)) return current
    if (
      input.deciderType === 'steward_agent'
      && option.action === 'approve'
      && isDangerousPermissionRequest(current)
    ) {
      throw new Error('Steward agent cannot approve dangerous action permission requests')
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

    const context = appendAudit(current.context, 'decision_submitted', {
      option_id: option.id,
      decider_type: input.deciderType,
      decider_user_id: input.deciderUserId ?? null,
      decider_agent_id: deciderAgentId,
      decision_source: input.decisionSource ?? null,
      idempotency_key: idempotencyKey,
    })

    db.prepare(
      `UPDATE permission_requests
       SET status = ?,
           selected_option_id = ?,
           decision_reason = ?,
           decider_type = ?,
           decider_user_id = ?,
           decider_agent_id = ?,
           context_json = ?,
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
      JSON.stringify(context),
      input.requestId,
      input.workspaceId,
    )

    const decided = getPermissionRequest(input.requestId, input.workspaceId, db)
    if (!decided) throw new Error('Permission request disappeared after decision')
    for (const event of resolveLinkedWatchEvents(decided.id, decided.workspace_id, db)) {
      updateHumanWatchEvent(
        event.id,
        decided.workspace_id,
        {
          status: 'resolved',
          resolvedAction: option.action === 'approve' ? 'approve_request' : 'deny_request',
          resolvedNote: reason,
          resolvedByType: input.deciderType,
          resolvedByUserId: input.deciderUserId ?? null,
          resolvedByAgentId: deciderAgentId,
          contextPatch: {
            permission_status: decided.status,
            selected_option_id: option.id,
          },
        },
        db,
      )
    }
    eventBus.broadcast('permission.decided', decided)
    return decided
  })()
}

export function recordWorkerHumanReply(
  input: WorkerHumanReplyInput,
  database?: Database.Database,
): PermissionRequestView {
  const db = dbOr(database)
  const current = getPermissionRequest(input.requestId, input.workspaceId, db)
  if (!current) throw new Error('Permission request not found')
  const key = normalizeIdempotencyKey(input.idempotencyKey) || normalizeIdempotencyKey(
    input.messageId ? `worker-reply:${input.sessionId ?? 'unknown'}:${input.messageId}` : null,
  )
  if (hasDecisionIdempotencyKey(current.context, key)) return current
  if (current.status !== 'pending') {
    const context = appendAudit(current.context, 'worker_human_reply_late', {
      client_node_id: input.clientNodeId ?? null,
      session_id: input.sessionId ?? null,
      message_id: input.messageId ?? null,
      reply_text: input.replyText ?? null,
      selected_option_id: input.selectedOptionId,
      idempotency_key: key,
      status: current.status,
    })
    db.prepare(
      `UPDATE permission_requests
       SET context_json = ?, updated_at = unixepoch()
       WHERE id = ? AND workspace_id = ?`,
    ).run(JSON.stringify(context), input.requestId, input.workspaceId)
    const updated = getPermissionRequest(input.requestId, input.workspaceId, db)
    if (!updated) throw new Error('Permission request disappeared after worker reply audit')
    for (const event of resolveLinkedWatchEvents(updated.id, updated.workspace_id, db)) {
      updateHumanWatchEvent(
        event.id,
        updated.workspace_id,
        {
          contextPatch: {
            worker_human_reply_late: true,
            permission_status: updated.status,
          },
        },
        db,
      )
    }
    eventBus.broadcast('permission.decided', updated)
    throw new Error(`Permission request is ${current.status}`)
  }

  const context = appendAudit(current.context, 'worker_human_reply_received', {
    client_node_id: input.clientNodeId ?? null,
    session_id: input.sessionId ?? null,
    message_id: input.messageId ?? null,
    reply_text: input.replyText ?? null,
    selected_option_id: input.selectedOptionId,
    operator_user_id: input.operatorUserId ?? null,
    observed_at: input.observedAt ?? null,
    reply_idempotency_key: key,
  })
  db.prepare(
    `UPDATE permission_requests
     SET context_json = ?, updated_at = unixepoch()
     WHERE id = ? AND workspace_id = ? AND status = 'pending'`,
  ).run(JSON.stringify(context), input.requestId, input.workspaceId)

  return decidePermissionRequest(
    {
      requestId: input.requestId,
      workspaceId: input.workspaceId,
      optionId: input.selectedOptionId,
      reason: input.replyText ?? null,
      deciderType: input.operatorUserId != null ? 'human_user' : 'human_external',
      deciderUserId: input.operatorUserId ?? null,
      decisionSource: 'worker_session_reply',
      idempotencyKey: key,
    },
    db,
  )
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
