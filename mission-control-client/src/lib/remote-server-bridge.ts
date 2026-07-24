/**
 * Remote Server Bridge — Server-side persistent WebSocket client
 *
 * Proactively connects this local E-Agent-Client instance to a remote
 * E-Agent-Client server so the server can push tasks down to local agents.
 *
 * Configured via:
 *   MC_REMOTE_SERVER_URL   — WebSocket URL of the remote server (ws:// or wss://)
 *   MC_REMOTE_SERVER_TOKEN — Optional bearer token for authentication
 *   MC_REMOTE_RECONNECT_MS — Reconnect delay in ms (default: 5000)
 *
 * Protocol (JSON over WebSocket):
 *   Client → Server:  { type: 'hello', clientId, version, capabilities[] }
 *   Server → Client:  { type: 'task_dispatch', task: {...} }
 *                     { type: 'ping' }
 *                     { type: 'command', action: string, payload: any }
 *   Client → Server:  { type: 'pong' }
 *                     { type: 'task_ack', taskId, status }
 *                     { type: 'agent_status', agents: [...] }
 */

import { EventEmitter } from 'events'
import { getDatabase, db_helpers } from './db'
import { resolveLocalClientId } from './edge-client-identity'
import { eventBus } from './event-bus'
import { logger } from './logger'
import { REMOTE_SERVER_URL, REMOTE_SERVER_TOKEN, REMOTE_RECONNECT_MS } from './config'
import {
  enqueueLocalSessionPrompt,
  isLocalSessionKind,
  type LocalSessionKind,
} from './local-session-executor'
import { readLocalSessionTranscriptPage, type LocalSessionTranscriptKind } from './session-transcript'
import { notifySessionTranscriptUpdated } from './session-realtime'
import { findAgentsBoundToSession } from './agents-by-session'
import { validateAgentSessionKindBinding } from './agent-session-binding'
import { resolveSessionKindForBinding } from './infer-local-session-kind'
import {
  createHumanWatchStewardAgent,
  deleteHumanWatchStewardAgent,
  updateHumanWatchStewardAgent,
  type CreateHumanWatchStewardInput,
} from './human-watch-steward'
import { runStewardJudgeOnEdge } from './human-watch-judge'
import { isBindableSessionKind } from './agent-session-binding'
import { deliverAgentMessage } from './deliver-agent-message'
import { edgeUpstreamFetch, isEdgeTlsInsecure } from './edge-upstream-fetch'
import { searchLocalMemory } from './memory-sync'
import {
  getPermissionRequest,
  isDangerousPermissionRequest,
  listPermissionRequests,
  upsertPermissionRequestSnapshot,
  type PermissionRequestOption,
  type PermissionRequestRisk,
  type PermissionRequestStatus,
  type PermissionRequestView,
} from './permission-requests'
import { logSecurityEvent } from './security-events'
import { validateLocalCliElevationGrant } from './local-cli-elevation-audit'
import { getAgentWorkspaceCandidates, readAgentWorkspaceFile } from './agent-workspace'
import type { HumanWatchEvent } from '@/store'

function safeLog(
  level: 'info' | 'warn' | 'error' | 'debug',
  message: string,
  payload?: Record<string, unknown>,
) {
  try {
    if (payload) {
      logger[level](payload, message)
    } else {
      logger[level](message)
    }
  } catch {
    // Next.js dev workers can throw "the worker has exited" while writing logs
    // from background bridge callbacks. Never let logging kill the bridge flow.
  }
}

// We use the native ws library if available (Node 18+ has it natively via global WebSocket)
// In Next.js server context, we use the 'ws' package for server-side WebSocket.

let WebSocketImpl: typeof WebSocket

async function getWebSocketImpl(): Promise<typeof WebSocket> {
  if (WebSocketImpl) return WebSocketImpl
  // Node 18+ has globalThis.WebSocket, but it's a browser API — use 'ws' package on server
  try {
    const { WebSocket: WsClass } = await import('ws' as any)
    WebSocketImpl = WsClass as unknown as typeof WebSocket
  } catch {
    // Fallback: use globalThis.WebSocket (available in some runtimes)
    WebSocketImpl = globalThis.WebSocket
  }
  return WebSocketImpl
}

// ---------------------------------------------------------------------------
// Bridge state
// ---------------------------------------------------------------------------

interface BridgeState {
  ws: WebSocket | null
  reconnectTimer: ReturnType<typeof setTimeout> | null
  pingTimer: ReturnType<typeof setInterval> | null
  reconnectAttempts: number
  isShuttingDown: boolean
  connected: boolean
  lastPong: number
  resolvedUrl: string
  discoverySource: string | null
  /** Lifetime counters — accumulate across reconnects */
  totalReconnects: number
  totalMessagesSent: number
  totalMessagesReceived: number
  lastErrorAt: number | null
  lastError: string | null
  connectedAt: number | null
}

const state: BridgeState = {
  ws: null,
  reconnectTimer: null,
  pingTimer: null,
  reconnectAttempts: 0,
  isShuttingDown: false,
  connected: false,
  lastPong: 0,
  resolvedUrl: '',
  discoverySource: null,
  totalReconnects: 0,
  totalMessagesSent: 0,
  totalMessagesReceived: 0,
  lastErrorAt: null,
  lastError: null,
  connectedAt: null,
}

// Event emitter for bridge lifecycle events (used for monitoring)
export const bridgeEmitter = new EventEmitter()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getLocalClientId(): string {
  try {
    const db = getDatabase()
    const { randomUUID } = require('crypto')
    return resolveLocalClientId(db, () => `mc-local-${randomUUID()}`)
  } catch {
    // Ultimate fallback if even getDatabase fails
    return `mc-node-static`
  }
}

function getLocalClientLabel(): string {
  const envName = (process.env.MC_EDGE_CLIENT_NAME || '').trim()
  if (envName) return envName
  try {
    const db = getDatabase()
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'gateway.client_name'`).get() as { value?: string } | undefined
    const value = typeof row?.value === 'string' ? row.value.trim() : ''
    if (value) return value
  } catch {
    // ignore
  }
  return getLocalClientId()
}

function getLocalAgentList(): Array<{
  id: number
  name: string
  role: string
  status: string
  framework?: string
  parent_id?: number
  session_key?: string | null
  task_stats?: { total: number; assigned: number; in_progress: number; quality_review: number; done: number }
}> {
  try {
    const db = getDatabase()
    const agents = db.prepare(
      `SELECT id, name, role, status, framework, parent_id, session_key FROM agents WHERE hidden = 0 ORDER BY name`
    ).all() as Array<{
      id: number
      name: string
      role: string
      status: string
      framework?: string
      parent_id?: number
      session_key?: string | null
    }>
    const assigned = db.prepare(`
      SELECT assigned_to, status, COUNT(*) AS count
      FROM tasks WHERE workspace_id = 1 AND assigned_to IS NOT NULL
      GROUP BY assigned_to, status
    `).all() as Array<{ assigned_to: string; status: string; count: number }>
    return agents.map((agent) => {
      const aliases = new Set([agent.name, agent.session_key].filter(Boolean))
      const stats = { total: 0, assigned: 0, in_progress: 0, quality_review: 0, done: 0 }
      for (const row of assigned) {
        if (!aliases.has(row.assigned_to)) continue
        stats.total += row.count
        if (row.status in stats) stats[row.status as keyof typeof stats] += row.count
      }
      return { ...agent, task_stats: stats }
    })
  } catch {
    return []
  }
}

const AGENT_INVENTORY_EVENT_TYPES = new Set([
  'agent.created',
  'agent.updated',
  'agent.deleted',
  'agent.synced',
  'agent.status_changed',
])

const TASK_PROJECTION_EVENT_TYPES = new Set([
  'task.created',
  'task.updated',
  'task.deleted',
  'task.status_changed',
])

function pushLocalAgentInventory(ws: WebSocket | null): boolean {
  return safeSend(ws, {
    type: 'agent_status',
    clientId: getLocalClientId(),
    clientLabel: getLocalClientLabel(),
    agents: getLocalAgentList(),
    timestamp: Date.now(),
  })
}

function parseBridgeJsonValue(value: unknown, fallback: unknown) {
  if (typeof value !== 'string' || !value.trim()) return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

function getLocalTaskSnapshot(limitInput: unknown): {
  tasks: Array<Record<string, unknown>>
  total: number
  byStatus: Record<string, number>
  truncated: boolean
} {
  const limit = Math.max(1, Math.min(Number(limitInput) || 500, 1000))
  const db = getDatabase()
  const rows = db.prepare(`
    SELECT t.id, t.title, substr(COALESCE(t.description, ''), 1, 16000) AS description,
           t.status, t.priority, t.project_id, t.project_ticket_no,
           p.name AS project_name, p.ticket_prefix AS project_prefix,
           t.assigned_to, t.created_by, t.created_at, t.updated_at, t.due_date,
           t.estimated_hours, t.actual_hours, t.outcome, t.error_message,
           t.resolution, t.feedback_rating, t.feedback_notes, t.retry_count,
           t.completed_at, t.tags, t.metadata
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
    WHERE t.workspace_id = 1
    ORDER BY t.updated_at DESC, t.id DESC
    LIMIT ?
  `).all(limit) as Array<Record<string, unknown>>
  const stats = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM tasks WHERE workspace_id = 1
    GROUP BY status
  `).all() as Array<{ status: string; count: number }>
  const byStatus: Record<string, number> = {}
  let total = 0
  for (const row of stats) {
    byStatus[row.status] = row.count
    total += row.count
  }
  return {
    tasks: rows.map((task) => ({
      ...task,
      tags: parseBridgeJsonValue(task.tags, []),
      metadata: parseBridgeJsonValue(task.metadata, {}),
    })),
    total,
    byStatus,
    truncated: total > rows.length,
  }
}

function getLocalAgentDetail(localAgentId: number): Record<string, unknown> | null {
  try {
    const db = getDatabase()
    const row = db
      .prepare(`SELECT * FROM agents WHERE id = ? AND hidden = 0 LIMIT 1`)
      .get(localAgentId) as Record<string, unknown> | undefined
    if (!row) return null
    let config: Record<string, unknown> = {}
    if (row.config) {
      try {
        config =
          typeof row.config === 'string'
            ? (JSON.parse(row.config) as Record<string, unknown>)
            : (row.config as Record<string, unknown>)
      } catch {
        config = {}
      }
    }
    const aliases = [...new Set([
      String(row.name || '').trim(),
      String(row.session_key || '').trim(),
    ].filter(Boolean))]
    const placeholders = aliases.map(() => '?').join(', ')
    const recentTasks = aliases.length > 0
      ? db.prepare(`
          SELECT id, title, substr(COALESCE(description, ''), 1, 4000) AS description,
                 status, priority, assigned_to, created_at, updated_at, due_date,
                 tags, metadata, outcome, resolution, error_message
          FROM tasks
          WHERE workspace_id = 1 AND assigned_to IN (${placeholders})
          ORDER BY updated_at DESC LIMIT 50
        `).all(...aliases).map((task: any) => ({
          ...task,
          tags: parseBridgeJsonValue(task.tags, []),
          metadata: parseBridgeJsonValue(task.metadata, {}),
        }))
      : []
    const recentActivities = aliases.length > 0
      ? db.prepare(`
          SELECT id, type, entity_type, entity_id, actor,
                 substr(description, 1, 4000) AS description, created_at
          FROM activities
          WHERE workspace_id = 1 AND actor IN (${placeholders})
          ORDER BY created_at DESC LIMIT 50
        `).all(...aliases).map((activity: any) => ({
          ...activity,
        }))
      : []
    const workspaceConfig = {
      ...config,
      ...(row.workspace_path ? { workspace: row.workspace_path } : {}),
    }
    const candidates = getAgentWorkspaceCandidates(workspaceConfig, String(row.name || ''))
    const workspaceFiles = [
      ['agent.md', ['agent.md', 'AGENT.md', 'MISSION.md', 'USER.md']],
      ['identity.md', ['identity.md', 'IDENTITY.md']],
      ['soul.md', ['soul.md', 'SOUL.md']],
      ['WORKING.md', ['WORKING.md', 'working.md']],
      ['MEMORY.md', ['MEMORY.md', 'memory.md']],
      ['TOOLS.md', ['TOOLS.md', 'tools.md']],
      ['AGENTS.md', ['AGENTS.md', 'agents.md']],
    ].reduce((files, [key, names]) => {
      const match = readAgentWorkspaceFile(candidates, names as string[])
      files[key as string] = {
        exists: match.exists,
        content: match.content.slice(0, 256 * 1024),
      }
      return files
    }, {} as Record<string, { exists: boolean; content: string }>)
    return {
      ...row,
      config,
      recent_tasks: recentTasks,
      recent_activities: recentActivities,
      workspace_files: workspaceFiles,
      workspace_source: candidates[0] || null,
    }
  } catch {
    return null
  }
}

function syncPermissionRequestSnapshot(request: PermissionRequestView): void {
  upsertPermissionRequestSnapshot({
    id: request.id,
    workspaceId: request.workspace_id ?? 1,
    tenantId: request.tenant_id,
    clientId: request.client_id,
    bindingId: request.binding_id,
    workerSyncIndexId: request.worker_sync_index_id,
    workerLocalAgentId: request.worker_local_agent_id,
    workerName: request.worker_name,
    workerSessionId: request.worker_session_id,
    stewardSyncIndexId: request.steward_sync_index_id,
    stewardLocalAgentId: request.steward_local_agent_id,
    stewardName: request.steward_name,
    requestType: request.request_type,
    title: request.title,
    prompt: request.prompt,
    risk: request.risk as PermissionRequestRisk,
    status: request.status as PermissionRequestStatus,
    options: request.options as PermissionRequestOption[],
    context: request.context,
    selectedOptionId: request.selected_option_id,
    decisionReason: request.decision_reason,
    deciderType: request.decider_type,
    deciderUserId: request.decider_user_id,
    deciderAgentId: request.decider_agent_id,
    decidedAt: request.decided_at,
    expiresAt: request.expires_at,
    createdAt: request.created_at,
    updatedAt: request.updated_at,
  })
  void maybeAutoDecidePermissionRequest(request).catch((err) => {
    safeLog('warn', '[RemoteBridge] Auto decide permission request failed', {
      requestId: request.id,
      err: err instanceof Error ? err.message : String(err),
    })
  })
}

function getPermissionBoundSteward(request: PermissionRequestView): { localAgentId: number; name: string | null } | null {
  const localAgentId = Number(request.steward_local_agent_id)
  if (!Number.isFinite(localAgentId) || localAgentId <= 0) return null
  return {
    localAgentId,
    name: typeof request.steward_name === 'string' ? request.steward_name : null,
  }
}

function readPermissionJudgePromptTemplate(agentDetail: Record<string, unknown> | null): string {
  if (!agentDetail || typeof agentDetail !== 'object') return ''
  const raw = agentDetail.config
  let config: Record<string, unknown> = {}
  if (typeof raw === 'string') {
    try {
      config = JSON.parse(raw) as Record<string, unknown>
    } catch {
      config = {}
    }
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    config = raw as Record<string, unknown>
  }
  const steward =
    config.steward && typeof config.steward === 'object' && !Array.isArray(config.steward)
      ? (config.steward as Record<string, unknown>)
      : {}
  return typeof steward.permission_judge_prompt_template === 'string'
    ? steward.permission_judge_prompt_template.trim()
    : ''
}

function buildPermissionJudgePrompt(
  request: PermissionRequestView,
  permissionJudgePromptTemplate?: string,
): string {
  const context = request.context && typeof request.context === 'object' && !Array.isArray(request.context)
    ? request.context as Record<string, unknown>
    : {}
  const ctxBlock = typeof context.worker_judge_context === 'string' ? context.worker_judge_context.trim() : ''
  const options = request.options.map((option) => `- ${option.id}: ${option.label} / ${option.action}${option.description ? ` / ${option.description}` : ''}`).join('\n')
  const fallback = [
    '你是人工值守审批判官。',
    '请根据下面的权限请求判断应该 approve、deny，还是 ask_human。',
    '只输出一行 JSON，不要解释，不要 markdown，不要前后缀。',
    '格式必须是：{"decision":"approve|deny|ask_human","option_id":"...", "reason":"..."}',
    '规则：',
    '1. 如果是危险操作、删除、卸载、生产改动、提权、密钥操作，优先输出 ask_human。',
    '2. 只有在风险可接受且信息充分时才输出 approve。',
    '3. 如果信息不足，也输出 ask_human。',
    '',
    `标题: ${request.title}`,
    `类型: ${request.request_type}`,
    `风险: ${request.risk}`,
    `请求内容: ${request.prompt}`,
    '可选项:',
    options || '- 无',
    '',
    '结构化上下文:',
    ctxBlock || '(empty)',
  ].join('\n')
  const template = typeof permissionJudgePromptTemplate === 'string'
    ? permissionJudgePromptTemplate.trim()
    : ''
  if (!template) return fallback
  return template
    .replace(/\{title\}/g, request.title)
    .replace(/\{request_type\}/g, request.request_type)
    .replace(/\{risk\}/g, request.risk)
    .replace(/\{prompt\}/g, request.prompt)
    .replace(/\{options\}/g, options || '- 无')
    .replace(/\{context\}/g, ctxBlock || '(empty)')
}

function parsePermissionJudgeDecision(
  rawReply: string,
  request: PermissionRequestView,
): { optionId: string; reason: string } | null {
  const text = String(rawReply || '').trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as { decision?: unknown; option_id?: unknown; reason?: unknown }
    const decision = typeof parsed.decision === 'string' ? parsed.decision.trim() : ''
    const optionId = typeof parsed.option_id === 'string' ? parsed.option_id.trim() : ''
    const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : ''
    if (optionId && request.options.some((option) => option.id === optionId)) {
      return { optionId, reason }
    }
    if (decision === 'approve') {
      const option = request.options.find((item) => item.action === 'approve')
      if (option) return { optionId: option.id, reason }
    }
    if (decision === 'deny') {
      const option = request.options.find((item) => item.action === 'deny')
      if (option) return { optionId: option.id, reason }
    }
    if (decision === 'ask_human') {
      const option = request.options.find((item) => item.action === 'ask_human' || item.action === 'deny')
      if (option) return { optionId: option.id, reason: reason || 'requires_human_review' }
    }
  } catch {}
  return null
}

async function maybeAutoDecidePermissionRequest(request: PermissionRequestView): Promise<void> {
  if (request.status !== 'pending') return
  if (!isRemoteBridgeConnected()) return
  const steward = getPermissionBoundSteward(request)
  if (!steward) return
  if (isDangerousPermissionRequest(request)) return

  const latest = getPermissionRequest(request.id, request.workspace_id ?? 1)
  if (!latest || latest.status !== 'pending') return

  const stewardDetail = getLocalAgentDetail(steward.localAgentId)
  const prompt = buildPermissionJudgePrompt(latest, readPermissionJudgePromptTemplate(stewardDetail))
  const result = await runStewardJudgeOnEdge(steward.localAgentId, prompt)
  const decision = parsePermissionJudgeDecision(result.reply, latest)
  if (!decision) return

  pushPermissionDecisionToUpstream({
    requestId: latest.id,
    optionId: decision.optionId,
    reason: decision.reason || `steward_auto_decision:${steward.localAgentId}`,
    deciderAgentId: String(steward.localAgentId),
  })
}

function syncHumanWatchEventSnapshot(eventRow: HumanWatchEvent): void {
  eventBus.broadcast('human_watch.event', eventRow)
}

export function __testSetBridgeSocket(ws: WebSocket | null): void {
  state.ws = ws
  state.connected = Boolean(ws)
}

export function __testHandleBridgeMessage(raw: string): void {
  handleMessage(raw)
}

export function __testSyncPermissionRequestSnapshot(request: PermissionRequestView): void {
  syncPermissionRequestSnapshot(request)
}

export function isRemoteBridgeConnected(): boolean {
  return state.connected && state.ws?.readyState === 1
}

function handleAgentsBySessionRequest(message: any): void {
  const requestId = typeof message?.requestId === 'string' ? message.requestId : ''
  const sessionId = typeof message?.sessionId === 'string' ? message.sessionId.trim() : ''
  const sessionKey = typeof message?.sessionKey === 'string' ? message.sessionKey.trim() : ''
  if (!requestId) return

  try {
    const db = getDatabase()
    const agents = findAgentsBoundToSession(db, 1, sessionId, sessionKey)
    safeSend(state.ws, {
      type: 'agents_by_session_response',
      requestId,
      ok: true,
      agents,
      source: 'remote-bridge',
    })
  } catch (err: any) {
    safeSend(state.ws, {
      type: 'agents_by_session_response',
      requestId,
      ok: false,
      error: err?.message || 'Failed to lookup agents by session',
    })
  }
}

async function handleAgentSessionUpdateRequest(message: any): Promise<void> {
  const requestId = typeof message?.requestId === 'string' ? message.requestId : ''
  const localAgentId = Number(message?.localAgentId)
  const sessionKey = typeof message?.sessionKey === 'string' ? message.sessionKey : ''
  const sessionKind = typeof message?.sessionKind === 'string' ? message.sessionKind : ''
  if (!requestId) return

  if (!Number.isFinite(localAgentId)) {
    safeSend(state.ws, {
      type: 'agent_session_update_response',
      requestId,
      ok: false,
      error: 'localAgentId is required',
    })
    return
  }

  try {
    const db = getDatabase()
    const agent = db
      .prepare(`SELECT id, name, framework, config FROM agents WHERE id = ? AND hidden = 0 LIMIT 1`)
      .get(localAgentId) as { id: number; name: string; framework: string | null; config: string | null } | undefined
    if (!agent) {
      safeSend(state.ws, {
        type: 'agent_session_update_response',
        requestId,
        ok: false,
        error: 'Agent not found',
      })
      return
    }

    const trimmedKey = sessionKey.trim()
    if (trimmedKey) {
      const resolvedKind = resolveSessionKindForBinding(trimmedKey, sessionKind || undefined)
      const kindCheck = validateAgentSessionKindBinding(agent.framework, resolvedKind)
      if (!kindCheck.ok) {
        safeSend(state.ws, {
          type: 'agent_session_update_response',
          requestId,
          ok: false,
          error: kindCheck.message,
        })
        return
      }
    }

    let config: Record<string, unknown> = {}
    if (agent.config) {
      try {
        config = JSON.parse(agent.config) as Record<string, unknown>
      } catch {
        config = {}
      }
    }
    const mergedConfig = {
      ...config,
      primary_session_key: trimmedKey || null,
      session_state: trimmedKey ? 'ready' : 'pending',
      session_bootstrap_state: 'pending',
      session_bootstrap_hash: null,
      session_bootstrap_error: null,
      ...(trimmedKey ? { mc_bound_agent_id: agent.id } : {}),
    }
    if (!trimmedKey) {
      delete mergedConfig.mc_bound_agent_id
    }

    const now = Math.floor(Date.now() / 1000)
    db.prepare(
      `UPDATE agents SET session_key = ?, config = ?, updated_at = ? WHERE id = ?`,
    ).run(trimmedKey || null, JSON.stringify(mergedConfig), now, agent.id)

    eventBus.broadcast('agent.updated', { id: agent.id, name: agent.name, session_key: trimmedKey || null })

    const updated = getLocalAgentDetail(agent.id)
    safeSend(state.ws, {
      type: 'agent_session_update_response',
      requestId,
      ok: true,
      agent: updated,
      source: 'remote-bridge',
    })
  } catch (err: any) {
    safeSend(state.ws, {
      type: 'agent_session_update_response',
      requestId,
      ok: false,
      error: err?.message || 'Failed to update agent session binding',
    })
  }
}

function handleAgentDetailRequest(message: any): void {
  const requestId = typeof message?.requestId === 'string' ? message.requestId : ''
  const localAgentId = Number(message?.localAgentId)
  if (!requestId) return

  if (!Number.isFinite(localAgentId)) {
    safeSend(state.ws, {
      type: 'agent_detail_response',
      requestId,
      ok: false,
      error: 'localAgentId is required',
    })
    return
  }

  const agent = getLocalAgentDetail(localAgentId)
  if (!agent) {
    safeSend(state.ws, {
      type: 'agent_detail_response',
      requestId,
      ok: false,
      error: 'Agent not found',
    })
    return
  }

  safeSend(state.ws, {
    type: 'agent_detail_response',
    requestId,
    ok: true,
    agent,
    source: 'remote-bridge',
  })
}

function handleTaskSnapshotRequest(message: any): void {
  const requestId = typeof message?.requestId === 'string' ? message.requestId : ''
  if (!requestId) return
  try {
    const snapshot = getLocalTaskSnapshot(message?.limit)
    safeSend(state.ws, {
      type: 'task_snapshot_response',
      requestId,
      ok: true,
      ...snapshot,
      source: 'remote-bridge',
    })
  } catch (err: any) {
    safeSend(state.ws, {
      type: 'task_snapshot_response',
      requestId,
      ok: false,
      error: err?.message || 'Failed to read local task snapshot',
    })
  }
}

function safeSend(ws: WebSocket | null, data: object): boolean {
  if (!ws || ws.readyState !== 1 /* OPEN */) return false
  try {
    ws.send(JSON.stringify(data))
    state.totalMessagesSent++
    return true
  } catch {
    return false
  }
}

function isWebSocketUrl(value: string): boolean {
  const normalized = String(value || '').trim().toLowerCase()
  return normalized.startsWith('ws://') || normalized.startsWith('wss://')
}

function isHttpUrl(value: string): boolean {
  const normalized = String(value || '').trim().toLowerCase()
  return normalized.startsWith('http://') || normalized.startsWith('https://')
}

function readBridgeSetting(key: string): string {
  try {
    const db = getDatabase()
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined
    return typeof row?.value === 'string' ? row.value.trim() : ''
  } catch {
    return ''
  }
}

/** Env MC_REMOTE_SERVER_URL wins; else settings gateway.server_url + gateway.token */
export function getRemoteUpstreamConfig(): {
  baseUrl: string
  token: string
  source: 'env' | 'settings' | null
} {
  const envUrl = REMOTE_SERVER_URL.trim()
  if (envUrl) {
    return { baseUrl: envUrl, token: REMOTE_SERVER_TOKEN, source: 'env' }
  }
  const settingsUrl = readBridgeSetting('gateway.server_url')
  if (settingsUrl) {
    return {
      baseUrl: settingsUrl,
      token: readBridgeSetting('gateway.token') || REMOTE_SERVER_TOKEN,
      source: 'settings',
    }
  }
  return { baseUrl: '', token: REMOTE_SERVER_TOKEN, source: null }
}

async function resolveRemoteBridgeUrl(): Promise<{ wsUrl: string; discoverySource: string | null }> {
  const { baseUrl: configured, token } = getRemoteUpstreamConfig()
  if (!configured) {
    throw new Error('Remote server URL not configured (MC_REMOTE_SERVER_URL or settings gateway.server_url)')
  }

  if (isWebSocketUrl(configured)) {
    return { wsUrl: configured, discoverySource: null }
  }

  if (isHttpUrl(configured)) {
    const base = configured.replace(/\/+$/, '')
    const infoUrl = `${base}/api/bridge/info`
    const headers: Record<string, string> = {}
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
      headers['x-api-key'] = token
    }

    const res = await edgeUpstreamFetch(infoUrl, { headers, cache: 'no-store' })
    const payload = await res.json().catch(() => null)
    if (!res.ok) {
      throw new Error(payload?.error || `Bridge discovery failed with status ${res.status}`)
    }

    const wsUrl = String(payload?.bridge?.ws_url || '').trim()
    if (!isWebSocketUrl(wsUrl)) {
      throw new Error('Bridge discovery response did not include a valid websocket URL')
    }

    return { wsUrl, discoverySource: infoUrl }
  }

  throw new Error('Remote server URL must be an http(s) base URL or ws(s) bridge URL')
}

// ---------------------------------------------------------------------------
// Incoming message handlers
// ---------------------------------------------------------------------------

async function handleTaskDispatch(payload: any): Promise<void> {
  if (!payload || typeof payload !== 'object') {
    safeLog('warn', '[RemoteBridge] Received task_dispatch with no payload')
    return
  }

  const {
    taskId: remoteTaskId,
    title,
    description,
    priority = 'medium',
    assignTo = null,
    tags = [],
    metadata = {},
  } = payload

  safeLog('info', '[RemoteBridge] Received task from remote server', { remoteTaskId, title, assignTo })

  try {
    const db = getDatabase()
    const now = Math.floor(Date.now() / 1000)
    const workspaceId = 1

    // Determine target agent
    let targetAgent: string | null = null
    if (assignTo) {
      const agentRow = db.prepare(
        `SELECT name FROM agents WHERE (name = ? OR id = ?) AND hidden = 0 LIMIT 1`
      ).get(assignTo, Number(assignTo) || 0) as { name: string } | undefined
      if (agentRow) {
        targetAgent = agentRow.name
      }
    }

    // If no explicit agent, route to best available via auto-routing later
    const status = targetAgent ? 'assigned' : 'inbox'
    const tagsJson = Array.isArray(tags) ? JSON.stringify(tags) : '[]'

    // Check for duplicate (same remote task ID) — idempotent
    const existingRow = metadata.remote_task_id
      ? (db.prepare(
          `SELECT id FROM tasks WHERE metadata LIKE ? AND workspace_id = ?`
        ).get(`%"remote_task_id":"${metadata.remote_task_id}"%`, workspaceId) as { id: number } | undefined)
      : undefined

    if (existingRow) {
      safeLog('info', '[RemoteBridge] Task already exists, skipping duplicate', { taskId: existingRow.id, remoteTaskId })
      safeSend(state.ws, { type: 'task_ack', taskId: remoteTaskId, status: 'duplicate', localTaskId: existingRow.id })
      return
    }

    const mergedMeta = { ...metadata, remote_task_id: remoteTaskId, source: 'remote_server' }

    const result = db.prepare(`
      INSERT INTO tasks (title, description, status, priority, assigned_to, created_by, project_id, project_ticket_no, tags, metadata, workspace_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'remote-server', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(title || 'Remote Task'),
      description ? String(description) : null,
      status,
      priority,
      targetAgent,
      payload.projectId || null,
      payload.projectTicketNo || null,
      tagsJson,
      JSON.stringify(mergedMeta),
      workspaceId,
      now,
      now,
    )

    const localTaskId = Number(result.lastInsertRowid)

    db_helpers.logActivity(
      'remote_task_received',
      'task',
      localTaskId,
      'remote-server',
      `Received task "${title}" from remote server${targetAgent ? ` → ${targetAgent}` : ' (auto-route)'}`,
      { remoteTaskId, assignTo, source: 'remote_server' },
      workspaceId,
    )

    eventBus.broadcast('task.created', {
      id: localTaskId,
      title,
      status,
      assigned_to: targetAgent,
      workspace_id: workspaceId,
    })

    // Acknowledge to server
    safeSend(state.ws, {
      type: 'task_ack',
      taskId: remoteTaskId,
      status: 'accepted',
      localTaskId,
    })

    bridgeEmitter.emit('task_received', { localTaskId, remoteTaskId, title })
    safeLog('info', '[RemoteBridge] Task created locally', { localTaskId, remoteTaskId, assignTo: targetAgent, status })
  } catch (err: any) {
    safeLog('error', '[RemoteBridge] Failed to create task from remote', { err, remoteTaskId })
    safeSend(state.ws, { type: 'task_ack', taskId: remoteTaskId, status: 'error', error: err.message })
  }
}

async function handleIncomingChatMessage(message: any): Promise<void> {
  if (!message || !message.content || !message.conversation_id) return

  try {
    const db = getDatabase()
    const workspaceId = 1 // Default

    // Check for duplicate
    const existing = db.prepare('SELECT id FROM messages WHERE conversation_id = ? AND content = ? AND created_at = ?')
      .get(message.conversation_id, message.content, message.created_at)
    
    if (existing) return

    db.prepare(`
      INSERT INTO messages (conversation_id, from_agent, to_agent, content, message_type, metadata, workspace_id, created_at, synced)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      message.conversation_id,
      message.from_agent,
      message.to_agent || null,
      message.content,
      message.message_type || 'text',
      message.metadata ? (typeof message.metadata === 'string' ? message.metadata : JSON.stringify(message.metadata)) : null,
      workspaceId,
      message.created_at || Math.floor(Date.now() / 1000)
    )

    // Broadcast locally so UI updates
    eventBus.broadcast('chat.message', { ...message, __from_bridge: true })
  } catch (err) {
    safeLog('error', '[RemoteBridge] Failed to handle incoming chat message', { err })
  }
}

function handleCommand(payload: any): void {
  const { action } = payload || {}

  switch (action) {
    case 'agent_status_request': {
      // Server is asking for current agent status
      const agents = getLocalAgentList()
      safeSend(state.ws, { type: 'agent_status', clientId: getLocalClientId(), clientLabel: getLocalClientLabel(), agents, timestamp: Date.now() })
      break
    }
    case 'ping_agents': {
      // Trigger agent heartbeat poll
      eventBus.broadcast('agent.synced' as any, { trigger: 'remote_command' })
      break
    }
    default:
      safeLog('warn', '[RemoteBridge] Unknown command action', { action })
  }
}

function handleStewardCreateRequest(message: any): void {
  const requestId = typeof message?.requestId === 'string' ? message.requestId : ''
  const steward = message?.steward && typeof message.steward === 'object' ? message.steward : {}
  const name = typeof steward?.name === 'string' ? steward.name.trim() : ''
  const framework = typeof steward?.framework === 'string' ? steward.framework.trim() : ''
  const soulContent = typeof steward?.soul_content === 'string' ? steward.soul_content : ''
  const workspacePath = typeof steward?.workspace_path === 'string' ? steward.workspace_path : ''
  const authorized = message?.authorized === true

  if (!requestId) return

  if (!name || !isBindableSessionKind(framework)) {
    safeSend(state.ws, {
      type: 'steward_create_response',
      requestId,
      ok: false,
      error: 'name and framework (claude-code | codex-cli) are required',
    })
    return
  }

  if (framework !== 'claude-code' && framework !== 'codex-cli') {
    safeSend(state.ws, {
      type: 'steward_create_response',
      requestId,
      ok: false,
      error: 'Only claude-code and codex-cli are supported for human-watch stewards',
    })
    return
  }

  try {
    const result = createHumanWatchStewardAgent({
      name,
      framework,
      soul_content: soulContent,
      workspace_path: workspacePath || null,
      authorized,
    } satisfies CreateHumanWatchStewardInput)

    const agents = getLocalAgentList()
    safeSend(state.ws, {
      type: 'agent_status',
      clientId: getLocalClientId(),
      clientLabel: getLocalClientLabel(),
      agents,
      timestamp: Date.now(),
    })

    safeSend(state.ws, {
      type: 'steward_create_response',
      requestId,
      ok: true,
      source: 'remote-bridge',
      sessionProvisioning: result.sessionProvisioning,
      agent: {
        id: result.agent.id,
        name: result.agent.name,
        role: result.agent.role,
        framework: result.agent.framework,
        session_key: result.agent.session_key,
        workspace_path: result.agent.workspace_path,
        status: result.agent.status,
        config: result.agent.config,
      },
    })
  } catch (err: any) {
    safeSend(state.ws, {
      type: 'steward_create_response',
      requestId,
      ok: false,
      error: err?.message || 'Failed to create human-watch steward',
    })
  }
}

function handleStewardUpdateRequest(message: any): void {
  const requestId = typeof message?.requestId === 'string' ? message.requestId : ''
  const localAgentId = Number(message?.localAgentId)
  const steward = message?.steward && typeof message.steward === 'object' ? message.steward : {}

  if (!requestId) return

  if (!Number.isFinite(localAgentId) || localAgentId <= 0) {
    safeSend(state.ws, {
      type: 'steward_update_response',
      requestId,
      ok: false,
      error: 'localAgentId is required',
    })
    return
  }

  try {
    const configPatch =
      steward?.config_patch && typeof steward.config_patch === 'object'
        ? (steward.config_patch as Record<string, unknown>)
        : null

    const updated = updateHumanWatchStewardAgent({
      id: localAgentId,
      name: typeof steward?.name === 'string' ? steward.name : undefined,
      soul_content: typeof steward?.soul_content === 'string' ? steward.soul_content : undefined,
      config_patch: configPatch,
    })

    const agents = getLocalAgentList()
    safeSend(state.ws, {
      type: 'agent_status',
      clientId: getLocalClientId(),
      clientLabel: getLocalClientLabel(),
      agents,
      timestamp: Date.now(),
    })

    safeSend(state.ws, {
      type: 'steward_update_response',
      requestId,
      ok: true,
      source: 'remote-bridge',
      agent: {
        id: updated.id,
        name: updated.name,
        role: updated.role,
        framework: updated.framework,
        session_key: updated.session_key,
        workspace_path: updated.workspace_path,
        status: updated.status,
        soul_content: updated.soul_content,
        config: updated.config,
      },
    })
  } catch (err: any) {
    safeSend(state.ws, {
      type: 'steward_update_response',
      requestId,
      ok: false,
      error: err?.message || 'Failed to update human-watch steward',
    })
  }
}

function handleStewardDeleteRequest(message: any): void {
  const requestId = typeof message?.requestId === 'string' ? message.requestId : ''
  const localAgentId = Number(message?.localAgentId)

  if (!requestId) return

  if (!Number.isFinite(localAgentId) || localAgentId <= 0) {
    safeSend(state.ws, {
      type: 'steward_delete_response',
      requestId,
      ok: false,
      error: 'localAgentId is required',
    })
    return
  }

  try {
    const result = deleteHumanWatchStewardAgent(localAgentId)
    const agents = getLocalAgentList()
    safeSend(state.ws, {
      type: 'agent_status',
      clientId: getLocalClientId(),
      clientLabel: getLocalClientLabel(),
      agents,
      timestamp: Date.now(),
    })

    safeSend(state.ws, {
      type: 'steward_delete_response',
      requestId,
      ok: true,
      deleted: true,
      name: result.deleted,
      source: 'remote-bridge',
    })
  } catch (err: any) {
    safeSend(state.ws, {
      type: 'steward_delete_response',
      requestId,
      ok: false,
      error: err?.message || 'Failed to delete human-watch steward',
    })
  }
}

async function handleAgentMessageRequest(message: any): Promise<void> {
  const requestId = typeof message?.requestId === 'string' ? message.requestId : ''
  const localAgentId = Number(message?.localAgentId)
  const body = typeof message?.message === 'string' ? message.message : ''
  const from = typeof message?.from === 'string' && message.from.trim()
    ? message.from.trim()
    : 'center'
  const localCliElevated = message?.localCliElevated === true
  const elevationGrant = localCliElevated ? validateLocalCliElevationGrant(message?.elevationGrant) : null

  if (!requestId) return
  if (localCliElevated && !elevationGrant) {
    safeSend(state.ws, {
      type: 'agent_message_response',
      requestId,
      ok: false,
      error: 'Invalid or missing elevation grant for elevated agent message',
    })
    return
  }

  if (!Number.isFinite(localAgentId) || localAgentId <= 0) {
    safeSend(state.ws, {
      type: 'agent_message_response',
      requestId,
      ok: false,
      error: 'localAgentId is required',
    })
    return
  }

  const agent = getLocalAgentDetail(localAgentId)
  if (!agent) {
    safeSend(state.ws, {
      type: 'agent_message_response',
      requestId,
      ok: false,
      error: 'Agent not found',
    })
    return
  }

  try {
    if (elevationGrant) {
      logSecurityEvent({
        event_type: 'local_cli_elevation_executed',
        severity: 'warning',
        source: 'remote_bridge_agent_message',
        agent_name: elevationGrant.agentName ?? String(agent.name || ''),
        detail: JSON.stringify(elevationGrant),
        workspace_id: elevationGrant.workspaceId,
        tenant_id: elevationGrant.tenantId,
      })
    }
    const result = await deliverAgentMessage({
      agent: {
        id: localAgentId,
        name: String(agent.name || ''),
        framework: typeof agent.framework === 'string' ? agent.framework : null,
        session_key: typeof agent.session_key === 'string' ? agent.session_key : null,
        config: agent.config,
      },
      message: body,
      from,
      skipAudit: true,
      localCliElevated,
    })
    if (!result.ok) {
      safeSend(state.ws, {
        type: 'agent_message_response',
        requestId,
        ok: false,
        error: result.error,
      })
      return
    }
    safeSend(state.ws, {
      type: 'agent_message_response',
      requestId,
      ok: true,
      success: true,
      source: 'remote-bridge',
      accepted: result.accepted,
      delivered: result.delivered,
      agent_id: result.agent_id,
      agent_name: result.agent_name,
      ...(result.session_key ? { session_key: result.session_key } : {}),
      ...(result.session_kind ? { session_kind: result.session_kind } : {}),
      ...(result.queued_prompt ? { queued_prompt: result.queued_prompt } : {}),
      ...(result.reply_preview ? { reply_preview: result.reply_preview } : {}),
    })
  } catch (err: any) {
    safeSend(state.ws, {
      type: 'agent_message_response',
      requestId,
      ok: false,
      error: err?.message || 'Agent message failed',
    })
  }
}

async function handleStewardJudgeRequest(message: any): Promise<void> {
  const requestId = typeof message?.requestId === 'string' ? message.requestId : ''
  const localAgentId = Number(message?.localAgentId)
  const prompt = typeof message?.prompt === 'string' ? message.prompt : ''

  if (!requestId) return

  if (!Number.isFinite(localAgentId) || localAgentId <= 0) {
    safeSend(state.ws, {
      type: 'steward_judge_response',
      requestId,
      ok: false,
      error: 'localAgentId is required',
    })
    return
  }

  if (activeStewardJudgeAgentIds.has(localAgentId)) {
    safeSend(state.ws, {
      type: 'steward_judge_response',
      requestId,
      ok: false,
      error: 'Steward judge already running for this agent',
    })
    return
  }

  activeStewardJudgeAgentIds.add(localAgentId)
  try {
    const result = await runStewardJudgeOnEdge(localAgentId, prompt)
    safeSend(state.ws, {
      type: 'steward_judge_response',
      requestId,
      ok: true,
      source: 'remote-bridge',
      reply: result.reply,
      sessionId: result.sessionId,
    })
  } catch (err: any) {
    safeSend(state.ws, {
      type: 'steward_judge_response',
      requestId,
      ok: false,
      error: err?.message || 'Steward judge failed',
    })
  } finally {
    activeStewardJudgeAgentIds.delete(localAgentId)
  }
}

async function handleSessionContinueRequest(message: any): Promise<void> {
  const requestId = typeof message?.requestId === 'string' ? message.requestId : ''
  const session = message?.session && typeof message.session === 'object' ? message.session : {}
  const kind = typeof session?.kind === 'string' ? session.kind : ''
  const sessionId = typeof session?.sessionId === 'string' ? session.sessionId : ''
  const prompt = typeof session?.prompt === 'string' ? session.prompt : ''
  const workingDirectory = typeof session?.workingDirectory === 'string'
    ? session.workingDirectory.trim()
    : typeof session?.working_dir === 'string'
      ? session.working_dir.trim()
      : ''
  const localCliElevated = session?.localCliElevated === true
  const elevationGrant = localCliElevated ? validateLocalCliElevationGrant(session?.elevationGrant) : null
  const permissionMode = localCliElevated ? 'full' as const : undefined

  if (!requestId) return
  if (localCliElevated && !elevationGrant) {
    safeSend(state.ws, {
      type: 'session_continue_response',
      requestId,
      ok: false,
      error: 'Invalid or missing elevation grant for elevated session continue',
    })
    return
  }

  if (!sessionId || !isLocalSessionKind(kind)) {
    safeSend(state.ws, {
      type: 'session_continue_response',
      requestId,
      ok: false,
      error: 'kind, sessionId, and prompt are required',
    })
    return
  }

  try {
    if (elevationGrant) {
      logSecurityEvent({
        event_type: 'local_cli_elevation_executed',
        severity: 'warning',
        source: 'remote_bridge_session_continue',
        agent_name: elevationGrant.agentName ?? undefined,
        detail: JSON.stringify(elevationGrant),
        workspace_id: elevationGrant.workspaceId,
        tenant_id: elevationGrant.tenantId,
      })
    }
    enqueueLocalSessionPrompt(kind as LocalSessionKind, sessionId, prompt, {
      managedByPlatform: true,
      workingDirectory: workingDirectory || null,
      permissionMode,
      dispatchAllowedTools: session?.dispatchAllowedTools ?? session?.dispatch_allowed_tools,
      dispatchMaxBudgetUsd: session?.dispatchMaxBudgetUsd ?? session?.dispatch_max_budget_usd,
      dispatchCwd: session?.dispatchCwd ?? session?.dispatch_cwd,
    })
    notifySessionTranscriptUpdated(kind, sessionId, 'bridge_continue_queued')
    safeSend(state.ws, {
      type: 'session_transcript_changed',
      session: { kind, sessionId },
    })
    safeSend(state.ws, {
      type: 'session_continue_response',
      requestId,
      ok: true,
      accepted: true,
      source: 'remote-bridge',
      sessionId,
    })
  } catch (err: any) {
    safeSend(state.ws, {
      type: 'session_continue_response',
      requestId,
      ok: false,
      error: err?.message || 'Failed to continue session',
    })
  }
}

function handleSessionTranscriptRequest(message: any): void {
  const requestId = typeof message?.requestId === 'string' ? message.requestId : ''
  const session = message?.session && typeof message.session === 'object' ? message.session : {}
  const kind = typeof session?.kind === 'string' ? session.kind : ''
  const sessionId = typeof session?.sessionId === 'string' ? session.sessionId : ''
  const limit = Math.min(Math.max(parseInt(String(session?.limit || '40'), 10) || 40, 1), 200)
  const before = typeof session?.before === 'string' ? session.before : undefined

  if (!requestId) return

  if (!sessionId || (kind !== 'claude-code' && kind !== 'codex-cli' && kind !== 'hermes')) {
    safeSend(state.ws, {
      type: 'session_transcript_response',
      requestId,
      ok: false,
      error: 'kind and sessionId are required',
    })
    return
  }

  try {
    const page = readLocalSessionTranscriptPage(kind as LocalSessionTranscriptKind, sessionId, { limit, before })
    safeSend(state.ws, {
      type: 'session_transcript_response',
      requestId,
      ok: true,
      source: 'remote-bridge',
      ...page,
    })
  } catch (err: any) {
    safeSend(state.ws, {
      type: 'session_transcript_response',
      requestId,
      ok: false,
      error: err?.message || 'Failed to read session transcript',
    })
  }
}

async function handleMemorySearchRequest(message: any): Promise<void> {
  const requestId = typeof message?.requestId === 'string' ? message.requestId : ''
  const query = typeof message?.query === 'string' ? message.query.trim() : ''
  const limit = Math.min(Math.max(Number(message?.limit || 5), 1), 20)
  if (!requestId) return

  if (!query) {
    safeSend(state.ws, {
      type: 'memory_search_response',
      requestId,
      ok: false,
      error: 'query is required',
    })
    return
  }

  try {
    const results = await searchLocalMemory(query, { limit })
    safeSend(state.ws, {
      type: 'memory_search_response',
      requestId,
      ok: true,
      source: 'remote-bridge',
      query,
      results,
    })
  } catch (err: any) {
    safeSend(state.ws, {
      type: 'memory_search_response',
      requestId,
      ok: false,
      error: err?.message || 'Failed to search local memory',
    })
  }
}

async function handleProjectsSync(payload: any): Promise<void> {
  const projects = Array.isArray(payload?.projects) ? payload.projects : []
  if (projects.length === 0) return

  try {
    const db = getDatabase()
    const now = Math.floor(Date.now() / 1000)
    
    db.transaction(() => {
      // Mark existing projects as inactive or just upsert?
      // For now, let's upsert everything from server.
      for (const p of projects) {
        db.prepare(`
          INSERT INTO projects (id, name, slug, description, ticket_prefix, ticket_counter, status, workspace_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            slug = excluded.slug,
            description = excluded.description,
            ticket_prefix = excluded.ticket_prefix,
            ticket_counter = excluded.ticket_counter,
            status = excluded.status,
            updated_at = excluded.updated_at
        `).run(
          p.id, p.name, p.slug, p.description, p.ticket_prefix, p.ticket_counter, 
          p.status || 'active', p.workspace_id || 1, now, now
        )
      }
    })()

    safeLog('info', '[RemoteBridge] Synced projects from server', { count: projects.length })
    eventBus.broadcast('project.synced' as any, { count: projects.length })
  } catch (err) {
    safeLog('error', '[RemoteBridge] Failed to sync projects', { err })
  }
}

function handleMessage(raw: string): void {
  state.totalMessagesReceived++
  let msg: any
  try {
    msg = JSON.parse(raw)
  } catch {
    safeLog('warn', '[RemoteBridge] Received non-JSON message, ignoring')
    return
  }

  const { type } = msg || {}

  switch (type) {
    case 'ping':
      safeSend(state.ws, { type: 'pong', timestamp: Date.now() })
      break

    case 'pong':
      state.lastPong = Date.now()
      break

    case 'welcome':
      safeLog('info', '[RemoteBridge] Server welcome received', { serverId: msg.serverId })
      // Send agent status on welcome
      safeSend(state.ws, { type: 'agent_status', clientId: getLocalClientId(), clientLabel: getLocalClientLabel(), agents: getLocalAgentList(), timestamp: Date.now() })
      import('./local-mailbox')
        .then(({ drainLocalMailbox }) => drainLocalMailbox())
        .catch((err) => safeLog('warn', '[RemoteBridge] welcome mailbox drain failed', { err }))
      break

    case 'task_dispatch':
      handleTaskDispatch(msg.task || msg.payload).catch((e) =>
        safeLog('error', '[RemoteBridge] task_dispatch handler failed', { err: e })
      )
      break

    case 'command':
      handleCommand(msg.payload || msg)
      break

    case 'ack':
      // Server acknowledged our message
      break

    case 'chat_message':
      if (msg.message) {
        handleIncomingChatMessage(msg.message).catch(e => 
          safeLog('error', '[RemoteBridge] chat_message handler failed', { err: e })
        )
      }
      break

    case 'session_transcript_request':
      handleSessionTranscriptRequest(msg)
      break

    case 'memory_search_request':
      handleMemorySearchRequest(msg).catch((e) =>
        safeLog('error', '[RemoteBridge] memory_search_request handler failed', { err: e }),
      )
      break

    case 'session_continue_request':
      handleSessionContinueRequest(msg).catch((e) =>
        safeLog('error', '[RemoteBridge] session_continue_request handler failed', { err: e })
      )
      break

    case 'agent_detail_request':
      handleAgentDetailRequest(msg)
      break

    case 'task_snapshot_request':
      handleTaskSnapshotRequest(msg)
      break

    case 'agents_by_session_request':
      handleAgentsBySessionRequest(msg)
      break

    case 'agent_session_update_request':
      handleAgentSessionUpdateRequest(msg).catch((e) =>
        safeLog('error', '[RemoteBridge] agent_session_update_request handler failed', { err: e })
      )
      break

    case 'steward_create_request':
      handleStewardCreateRequest(msg)
      break

    case 'steward_update_request':
      handleStewardUpdateRequest(msg)
      break

    case 'steward_delete_request':
      handleStewardDeleteRequest(msg)
      break

    case 'steward_judge_request':
      handleStewardJudgeRequest(msg).catch((e) =>
        safeLog('error', '[RemoteBridge] steward_judge_request handler failed', { err: e }),
      )
      break

    case 'agent_message_request':
      handleAgentMessageRequest(msg).catch((e) =>
        safeLog('error', '[RemoteBridge] agent_message_request handler failed', { err: e }),
      )
      break

    case 'permission_request_sync':
      try {
        const request = msg?.request && typeof msg.request === 'object' ? msg.request as PermissionRequestView : null
        if (request) syncPermissionRequestSnapshot(request)
      } catch (e) {
        safeLog('error', '[RemoteBridge] permission_request_sync handler failed', { err: e })
      }
      break

    case 'human_watch_event_sync':
      try {
        const eventRow = msg?.event && typeof msg.event === 'object' ? msg.event as HumanWatchEvent : null
        if (eventRow?.id) syncHumanWatchEventSnapshot(eventRow)
      } catch (e) {
        safeLog('error', '[RemoteBridge] human_watch_event_sync handler failed', { err: e })
      }
      break

    case 'edge_message_wakeup':
      import('./local-mailbox')
        .then(({ drainLocalMailbox }) => drainLocalMailbox())
        .catch((err) => safeLog('warn', '[RemoteBridge] Edge message wakeup drain failed', { err }))
      break

    case 'projects_sync':
      handleProjectsSync(msg).catch(e =>
        safeLog('error', '[RemoteBridge] projects_sync handler failed', { err: e })
      )
      break

    default:
      if (type) {
        safeLog('debug', '[RemoteBridge] Unhandled message type', { type })
      }
  }
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

const PING_INTERVAL_MS = 25_000
const MAX_PONG_SILENCE_MS = 5 * 60_000
const activeStewardJudgeAgentIds = new Set<number>()

function startHeartbeat(): void {
  stopHeartbeat()
  state.lastPong = Date.now()
  let lastTickAt = Date.now()
  state.pingTimer = setInterval(() => {
    if (!state.ws || state.ws.readyState !== 1) {
      stopHeartbeat()
      return
    }
    const now = Date.now()
    const tickGap = now - lastTickAt
    lastTickAt = now
    // setInterval pauses during system sleep — force reconnect if we missed several beats
    if (tickGap > PING_INTERVAL_MS * 2.5) {
      safeLog('warn', '[RemoteBridge] Heartbeat gap (possible sleep) — forcing reconnect', { tickGap })
      state.ws.close(4000, 'Post-sleep reconnect')
      return
    }
    if (now - state.lastPong > MAX_PONG_SILENCE_MS) {
      safeLog('warn', '[RemoteBridge] No pong received for too long, forcing reconnect')
      state.ws.close(4000, 'Heartbeat timeout')
      return
    }
    safeSend(state.ws, { type: 'ping', timestamp: Date.now() })
  }, PING_INTERVAL_MS)
}

function stopHeartbeat(): void {
  if (state.pingTimer) {
    clearInterval(state.pingTimer)
    state.pingTimer = null
  }
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

async function connect(): Promise<void> {
  if (state.isShuttingDown) return
  if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) {
    // Already connecting or connected
    return
  }

  const resolved = await resolveRemoteBridgeUrl()
  const { token: bridgeToken } = getRemoteUpstreamConfig()
  const url = new URL(resolved.wsUrl)

  const WS = await getWebSocketImpl()
  let ws: WebSocket

  try {
    const headers: Record<string, string> = {}
    if (bridgeToken) {
      headers['Authorization'] = `Bearer ${bridgeToken}`
    }
    const wsOptions: Record<string, unknown> = { headers }
    if (isEdgeTlsInsecure() && url.protocol === 'wss:') {
      wsOptions.rejectUnauthorized = false
    }
    // ws package accepts headers + TLS options; native WebSocket does not (browser constraint)
    ws = new (WS as any)(url.toString(), [], wsOptions) as WebSocket
  } catch {
    ws = new WS(url.toString()) as WebSocket
  }

  state.ws = ws
  state.resolvedUrl = resolved.wsUrl
  state.discoverySource = resolved.discoverySource
  const clientId = getLocalClientId()
  const clientLabel = getLocalClientLabel()

  const connectTimeout = setTimeout(() => {
    if (!state.connected && state.ws === ws) {
      safeLog('warn', '[RemoteBridge] Connection timeout (15s) — forcing close', { url: resolved.wsUrl })
      try { ws.close(4008, 'Connect timeout') } catch {}
    }
  }, 15_000)

  ws.onopen = () => {
    clearTimeout(connectTimeout)
    state.connected = true
    state.reconnectAttempts = 0
    state.connectedAt = Date.now()
    state.lastPong = Date.now()
    safeLog('info', '[RemoteBridge] Connected to remote server', {
      url: resolved.wsUrl,
      discoverySource: resolved.discoverySource,
      totalReconnects: state.totalReconnects,
    })

    // Send hello handshake
    safeSend(ws, {
      type: 'hello',
      clientId,
      clientLabel,
      version: '1.0',
      capabilities: [
        'task_receive',
        'agent_status',
        'agent_detail',
        'task_snapshot',
        'agents_by_session',
        'agent_session_update',
        'heartbeat',
        'chat_sync',
        'session_transcript',
        'session_continue',
        'steward_create',
        'steward_update',
        'steward_delete',
        'steward_judge',
        'reliable_mailbox',
        'human_watch_assist_v2',
        'permission_decision_relay',
        'serial_session_continue',
      ],
      agents: getLocalAgentList(),
      timestamp: Date.now(),
    })

    // Listen for local chat messages and forward them
    const chatHandler = (event: any) => {
      // Avoid loops: check if message was already synced
      if (state.connected && !event.__from_bridge) {
        safeSend(ws, { type: 'chat_message', message: event })
      }
    }
    eventBus.on('chat.message', chatHandler)

    let taskProjectionTimer: NodeJS.Timeout | null = null
    const agentInventoryHandler = (event: { type?: string }) => {
      const eventType = String(event?.type || '')
      if (AGENT_INVENTORY_EVENT_TYPES.has(eventType)) {
        pushLocalAgentInventory(ws)
      }
      if (!TASK_PROJECTION_EVENT_TYPES.has(eventType)) return
      if (taskProjectionTimer) clearTimeout(taskProjectionTimer)
      taskProjectionTimer = setTimeout(() => {
        taskProjectionTimer = null
        pushLocalAgentInventory(ws)
        safeSend(ws, {
          type: 'task_snapshot_changed',
          clientId,
          timestamp: Date.now(),
        })
      }, 250)
    }
    eventBus.on('server-event', agentInventoryHandler)

    startHeartbeat()
    bridgeEmitter.emit('connected', { url: resolved.wsUrl, discoverySource: resolved.discoverySource })

    // Store handler for cleanup
    ;(ws as any)._chatHandler = chatHandler
    ;(ws as any)._agentInventoryHandler = agentInventoryHandler
    ;(ws as any)._clearTaskProjectionTimer = () => {
      if (taskProjectionTimer) clearTimeout(taskProjectionTimer)
      taskProjectionTimer = null
    }
  }

  ws.onmessage = (event: MessageEvent) => {
    handleMessage(typeof event.data === 'string' ? event.data : String(event.data))
  }

  ws.onerror = (event: Event) => {
    clearTimeout(connectTimeout)
    const errMsg = (event as any)?.message || 'WebSocket error'
    state.lastError = errMsg
    state.lastErrorAt = Date.now()
    safeLog('warn', '[RemoteBridge] WebSocket error, will reconnect...', { err: errMsg, url: state.resolvedUrl })
    bridgeEmitter.emit('bridge_error', { message: errMsg })
  }

  ws.onclose = (event: CloseEvent) => {
    clearTimeout(connectTimeout)
    const durationMs = state.connectedAt ? Date.now() - state.connectedAt : 0
    state.connected = false
    state.ws = null
    state.connectedAt = null
    stopHeartbeat()

    const handler = (ws as any)._chatHandler
    if (handler) eventBus.off('chat.message', handler)
    const agentInventoryHandler = (ws as any)._agentInventoryHandler
    if (agentInventoryHandler) eventBus.off('server-event', agentInventoryHandler)
    ;(ws as any)._clearTaskProjectionTimer?.()

    safeLog('info', '[RemoteBridge] Disconnected from remote server', {
      code: event?.code,
      reason: event?.reason,
      url: state.resolvedUrl || resolved.wsUrl,
      durationMs,
    })
    bridgeEmitter.emit('disconnected', { code: event?.code, reason: event?.reason })

    if (!state.isShuttingDown) {
      scheduleReconnect()
    }
  }
}

export function pushPermissionDecisionToUpstream(input: {
  requestId: string
  optionId: string
  reason?: string | null
  deciderAgentId?: string | null
}): boolean {
  const requestId = String(input.requestId || '').trim()
  const optionId = String(input.optionId || '').trim()
  if (!requestId || !optionId) return false
  if (!state.ws || state.ws.readyState !== 1) return false
  return safeSend(state.ws, {
    type: 'permission_decision_sync',
    requestId,
    optionId,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.deciderAgentId ? { deciderAgentId: input.deciderAgentId } : {}),
  })
}

export function pushWorkerHumanReplyToUpstream(input: {
  requestId: string
  selectedOptionId: string
  sessionId?: string | null
  messageId?: string | null
  replyText?: string | null
  observedAt?: string | null
  idempotencyKey?: string | null
}): boolean {
  const requestId = String(input.requestId || '').trim()
  const selectedOptionId = String(input.selectedOptionId || '').trim()
  if (!requestId || !selectedOptionId) return false
  if (!state.ws || state.ws.readyState !== 1) return false
  return safeSend(state.ws, {
    type: 'worker_human_reply_sync',
    requestId,
    selectedOptionId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.messageId ? { messageId: input.messageId } : {}),
    ...(input.replyText ? { replyText: input.replyText } : {}),
    ...(input.observedAt ? { observedAt: input.observedAt } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  })
}

function scheduleReconnect(): void {
  if (state.reconnectTimer) return
  const attempts = state.reconnectAttempts
  const base = Math.min(REMOTE_RECONNECT_MS * Math.pow(1.5, Math.min(attempts, 8)), 60_000)
  const jitter = base * 0.25 * Math.random()
  const delay = Math.round(base + jitter)
  state.totalReconnects++
  safeLog('info', '[RemoteBridge] Scheduling reconnect', { delay, attempts, totalReconnects: state.totalReconnects })
  state.reconnectAttempts += 1
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null
    connect().catch((e) => {
      safeLog('error', '[RemoteBridge] Reconnect threw', { err: e })
      scheduleReconnect()
    })
  }, Math.round(delay))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let _started = false

/** Notify upstream center that a local CLI session transcript changed (human-watch orchestrator). */
export function pushSessionTranscriptChangedToUpstream(
  kind: string,
  sessionId: string,
): void {
  const trimmed = String(sessionId || '').trim()
  if (!trimmed) return
  if (!isLocalSessionKind(kind)) return
  if (!state.ws || state.ws.readyState !== 1) return
  safeSend(state.ws, {
    type: 'session_transcript_changed',
    session: { kind, sessionId: trimmed },
  })
}

/**
 * Start the remote server bridge.
 * Safe to call multiple times — idempotent.
 * Does nothing if MC_REMOTE_SERVER_URL is not configured.
 */
export function startRemoteBridge(): void {
  const upstream = getRemoteUpstreamConfig()
  if (!upstream.baseUrl) {
    safeLog('info', '[RemoteBridge] No upstream URL (env or gateway.server_url) — bridge disabled')
    return
  }
  state.isShuttingDown = false
  if (isEdgeTlsInsecure()) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    process.env.MC_EDGE_TLS_INSECURE = '1'
  }
  if (_started) {
    if (!state.connected && !state.reconnectTimer) {
      connect().catch((e) => {
        safeLog('error', '[RemoteBridge] Connect retry failed', { err: e })
        scheduleReconnect()
      })
    }
    return
  }
  _started = true

  safeLog('info', '[RemoteBridge] Starting remote server bridge', { url: upstream.baseUrl, source: upstream.source })
  connect().catch((e) => {
    safeLog('error', '[RemoteBridge] Initial connect failed', { err: e })
    scheduleReconnect()
  })
}

/** Stop then start — used by UI reconnect and apply-bootstrap. */
export function restartRemoteBridge(): void {
  stopRemoteBridge()
  state.isShuttingDown = false
  state.reconnectAttempts = 0
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer)
    state.reconnectTimer = null
  }
  startRemoteBridge()
}

/**
 * Gracefully stop the bridge (e.g., on server shutdown).
 */
export function stopRemoteBridge(): void {
  state.isShuttingDown = true
  stopHeartbeat()
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer)
    state.reconnectTimer = null
  }
  if (state.ws) {
    try { state.ws.close(1000, 'Server shutting down') } catch { /* ignore */ }
    state.ws = null
  }
  state.connected = false
  state.resolvedUrl = ''
  state.discoverySource = null
  _started = false
  state.isShuttingDown = false
  safeLog('info', '[RemoteBridge] Bridge stopped')
}

/**
 * Get current bridge connection status for monitoring.
 */
export function getRemoteBridgeStatus(): {
  enabled: boolean
  connected: boolean
  url: string
  configuredUrl: string
  discoverySource: string | null
  reconnectAttempts: number
  lastPong: number
  pongSilenceMs: number
  connectedAt: number | null
  connectedDurationMs: number | null
  totalReconnects: number
  totalMessagesSent: number
  totalMessagesReceived: number
  lastError: string | null
  lastErrorAt: number | null
} {
  const upstream = getRemoteUpstreamConfig()
  const now = Date.now()
  return {
    enabled: Boolean(upstream.baseUrl),
    connected: state.connected,
    url: state.resolvedUrl || upstream.baseUrl,
    configuredUrl: upstream.baseUrl,
    discoverySource: state.discoverySource,
    reconnectAttempts: state.reconnectAttempts,
    lastPong: state.lastPong,
    pongSilenceMs: state.lastPong ? now - state.lastPong : 0,
    connectedAt: state.connectedAt,
    connectedDurationMs: state.connectedAt ? now - state.connectedAt : null,
    totalReconnects: state.totalReconnects,
    totalMessagesSent: state.totalMessagesSent,
    totalMessagesReceived: state.totalMessagesReceived,
    lastError: state.lastError,
    lastErrorAt: state.lastErrorAt,
  }
}

/**
 * Send a status update to the remote server (e.g., agent status change).
 * No-op if bridge is not connected.
 */
export function sendBridgeEvent(type: string, payload: object): boolean {
  return safeSend(state.ws, { type, ...payload, timestamp: Date.now() })
}
