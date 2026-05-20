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
  type CreateHumanWatchStewardInput,
} from './human-watch-steward'
import { runStewardJudgeOnEdge } from './human-watch-judge'
import { isBindableSessionKind } from './agent-session-binding'

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
}

// Event emitter for bridge lifecycle events (used for monitoring)
export const bridgeEmitter = new EventEmitter()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getLocalClientId(): string {
  try {
    const db = getDatabase()
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'device.client_id'`).get() as { value: string } | undefined
    if (row?.value) return row.value

    // Generate and persist a stable client ID
    const { randomUUID } = require('crypto')
    const id = `mc-local-${randomUUID()}`
    try {
      db.prepare(`INSERT OR IGNORE INTO settings (key, value, category) VALUES ('device.client_id', ?, 'device')`).run(id)
      return id
    } catch {
      // If DB fails to write, use a hash of the current directory as a semi-stable ID
      const { createHash } = require('crypto')
      const hostHash = createHash('md5').update(process.cwd()).digest('hex').substring(0, 8)
      return `mc-node-${hostHash}`
    }
  } catch {
    // Ultimate fallback if even getDatabase fails
    return `mc-node-static`
  }
}

function getLocalClientLabel(): string {
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
}> {
  try {
    const db = getDatabase()
    return db.prepare(
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
  } catch {
    return []
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
    return { ...row, config }
  } catch {
    return null
  }
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

function safeSend(ws: WebSocket | null, data: object): boolean {
  if (!ws || ws.readyState !== 1 /* OPEN */) return false
  try {
    ws.send(JSON.stringify(data))
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

    const res = await fetch(infoUrl, { headers, cache: 'no-store' })
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
    logger.warn('[RemoteBridge] Received task_dispatch with no payload')
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

  logger.info({ remoteTaskId, title, assignTo }, '[RemoteBridge] Received task from remote server')

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
      logger.info({ taskId: existingRow.id, remoteTaskId }, '[RemoteBridge] Task already exists, skipping duplicate')
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
    logger.info({ localTaskId, remoteTaskId, assignTo: targetAgent, status }, '[RemoteBridge] Task created locally')
  } catch (err: any) {
    logger.error({ err, remoteTaskId }, '[RemoteBridge] Failed to create task from remote')
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
    logger.error({ err }, '[RemoteBridge] Failed to handle incoming chat message')
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
      logger.warn({ action }, '[RemoteBridge] Unknown command action')
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

  if (!requestId) return

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
    enqueueLocalSessionPrompt(kind as LocalSessionKind, sessionId, prompt, {
      workingDirectory: workingDirectory || null,
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

    logger.info({ count: projects.length }, '[RemoteBridge] Synced projects from server')
    eventBus.broadcast('project.synced' as any, { count: projects.length })
  } catch (err) {
    logger.error({ err }, '[RemoteBridge] Failed to sync projects')
  }
}

function handleMessage(raw: string): void {
  let msg: any
  try {
    msg = JSON.parse(raw)
  } catch {
    logger.warn('[RemoteBridge] Received non-JSON message, ignoring')
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
      logger.info({ serverId: msg.serverId }, '[RemoteBridge] Server welcome received')
      // Send agent status on welcome
      safeSend(state.ws, { type: 'agent_status', clientId: getLocalClientId(), clientLabel: getLocalClientLabel(), agents: getLocalAgentList(), timestamp: Date.now() })
      break

    case 'task_dispatch':
      handleTaskDispatch(msg.task || msg.payload).catch((e) =>
        logger.error({ err: e }, '[RemoteBridge] task_dispatch handler failed')
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
          logger.error({ err: e }, '[RemoteBridge] chat_message handler failed')
        )
      }
      break

    case 'session_transcript_request':
      handleSessionTranscriptRequest(msg)
      break

    case 'session_continue_request':
      handleSessionContinueRequest(msg).catch((e) =>
        logger.error({ err: e }, '[RemoteBridge] session_continue_request handler failed')
      )
      break

    case 'agent_detail_request':
      handleAgentDetailRequest(msg)
      break

    case 'agents_by_session_request':
      handleAgentsBySessionRequest(msg)
      break

    case 'agent_session_update_request':
      handleAgentSessionUpdateRequest(msg).catch((e) =>
        logger.error({ err: e }, '[RemoteBridge] agent_session_update_request handler failed')
      )
      break

    case 'steward_create_request':
      handleStewardCreateRequest(msg)
      break

    case 'steward_judge_request':
      handleStewardJudgeRequest(msg).catch((e) =>
        logger.error({ err: e }, '[RemoteBridge] steward_judge_request handler failed'),
      )
      break

    case 'projects_sync':
      handleProjectsSync(msg).catch(e =>
        logger.error({ err: e }, '[RemoteBridge] projects_sync handler failed')
      )
      break

    default:
      if (type) {
        logger.debug({ type }, '[RemoteBridge] Unhandled message type')
      }
  }
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

const PING_INTERVAL_MS = 25_000
const MAX_PONG_SILENCE_MS = 90_000 // 3 missed pings

function startHeartbeat(): void {
  stopHeartbeat()
  state.lastPong = Date.now()
  state.pingTimer = setInterval(() => {
    if (!state.ws || state.ws.readyState !== 1) {
      stopHeartbeat()
      return
    }
    if (Date.now() - state.lastPong > MAX_PONG_SILENCE_MS) {
      logger.warn('[RemoteBridge] No pong received for too long, forcing reconnect')
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

  // Attach token as query param if provided (simple auth; server can also check header)
  if (bridgeToken) {
    url.searchParams.set('token', bridgeToken)
  }

  const WS = await getWebSocketImpl()
  let ws: WebSocket

  try {
    const headers: Record<string, string> = {}
    if (bridgeToken) {
      headers['Authorization'] = `Bearer ${bridgeToken}`
    }
    // ws package accepts headers; native WebSocket does not (browser constraint)
    ws = new (WS as any)(url.toString(), [], { headers }) as WebSocket
  } catch {
    ws = new WS(url.toString()) as WebSocket
  }

  state.ws = ws
  state.resolvedUrl = resolved.wsUrl
  state.discoverySource = resolved.discoverySource
  const clientId = getLocalClientId()
  const clientLabel = getLocalClientLabel()

  ws.onopen = () => {
    state.connected = true
    state.reconnectAttempts = 0
    logger.info({ url: resolved.wsUrl, discoverySource: resolved.discoverySource }, '[RemoteBridge] Connected to remote server')

    // Send hello handshake
    safeSend(ws, {
      type: 'hello',
      clientId,
      clientLabel,
      version: '1.0',
      capabilities: ['task_receive', 'agent_status', 'agent_detail', 'agents_by_session', 'agent_session_update', 'heartbeat', 'chat_sync', 'session_transcript', 'session_continue', 'steward_create', 'steward_judge'],
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

    startHeartbeat()
    bridgeEmitter.emit('connected', { url: resolved.wsUrl, discoverySource: resolved.discoverySource })
    
    // Store handler for cleanup
    ;(ws as any)._chatHandler = chatHandler
  }

  ws.onmessage = (event: MessageEvent) => {
    handleMessage(typeof event.data === 'string' ? event.data : String(event.data))
  }

  ws.onerror = (event: Event) => {
    // ws package passes an ErrorEvent; just log that an error occurred
    logger.warn('[RemoteBridge] WebSocket error, will reconnect...')
    bridgeEmitter.emit('bridge_error', { message: 'WebSocket error' })
  }

  ws.onclose = (event: CloseEvent) => {
    state.connected = false
    state.ws = null
    stopHeartbeat()
    
    const handler = (ws as any)._chatHandler
    if (handler) eventBus.off('chat.message', handler)

    logger.info({ code: event?.code, reason: event?.reason, url: state.resolvedUrl || resolved.wsUrl }, '[RemoteBridge] Disconnected from remote server')
    bridgeEmitter.emit('disconnected', { code: event?.code, reason: event?.reason })

    if (!state.isShuttingDown) {
      scheduleReconnect()
    }
  }
}

function scheduleReconnect(): void {
  if (state.reconnectTimer) return
  const attempts = state.reconnectAttempts
  // Exponential backoff capped at 60s
  const delay = Math.min(REMOTE_RECONNECT_MS * Math.pow(1.5, Math.min(attempts, 8)), 60_000)
  logger.info({ delay: Math.round(delay), attempts }, '[RemoteBridge] Scheduling reconnect')
  state.reconnectAttempts += 1
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null
    connect().catch((e) => {
      logger.error({ err: e }, '[RemoteBridge] Reconnect threw')
      scheduleReconnect()
    })
  }, Math.round(delay))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let _started = false

/**
 * Start the remote server bridge.
 * Safe to call multiple times — idempotent.
 * Does nothing if MC_REMOTE_SERVER_URL is not configured.
 */
export function startRemoteBridge(): void {
  const upstream = getRemoteUpstreamConfig()
  if (!upstream.baseUrl) {
    logger.info('[RemoteBridge] No upstream URL (env or gateway.server_url) — bridge disabled')
    return
  }
  if (_started) return
  _started = true

  logger.info({ url: upstream.baseUrl, source: upstream.source }, '[RemoteBridge] Starting remote server bridge')
  connect().catch((e) => {
    logger.error({ err: e }, '[RemoteBridge] Initial connect failed')
    scheduleReconnect()
  })
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
  state.resolvedUrl = ''
  state.discoverySource = null
  _started = false
  logger.info('[RemoteBridge] Bridge stopped')
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
} {
  const upstream = getRemoteUpstreamConfig()
  return {
    enabled: Boolean(upstream.baseUrl),
    connected: state.connected,
    url: state.resolvedUrl || upstream.baseUrl,
    configuredUrl: upstream.baseUrl,
    discoverySource: state.discoverySource,
    reconnectAttempts: state.reconnectAttempts,
    lastPong: state.lastPong,
  }
}

/**
 * Send a status update to the remote server (e.g., agent status change).
 * No-op if bridge is not connected.
 */
export function sendBridgeEvent(type: string, payload: object): boolean {
  return safeSend(state.ws, { type, ...payload, timestamp: Date.now() })
}
