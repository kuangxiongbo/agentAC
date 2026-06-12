/**
 * Remote Server Bridge — Server-side persistent WebSocket client
 *
 * Proactively connects this local E-Agent-Center instance to a remote
 * E-Agent-Center server so the server can push tasks down to local agents.
 *
 * Configured via:
 *   MC_REMOTE_SERVER_URL   — Remote mission-control parent address.
 *                           Supports either:
 *                           - HTTP base URL, e.g. http://192.168.1.10:5000
 *                           - direct bridge WS URL, e.g. ws://192.168.1.10:5002
 *   MC_REMOTE_SERVER_TOKEN — Optional bearer token for authentication
 *   MC_REMOTE_RECONNECT_MS — Reconnect delay in ms (default: 5000)
 */

import { EventEmitter } from 'events'
import { getDatabase, db_helpers } from './db'
import { eventBus } from './event-bus'
import { logger } from './logger'
import { REMOTE_SERVER_URL, REMOTE_SERVER_TOKEN, REMOTE_RECONNECT_MS } from './config'
import { readLocalSessionTranscriptPage, type LocalSessionTranscriptKind } from './session-transcript'

function getDbSetting(key: string, defaultValue: string = ''): string {
  try {
    const db = getDatabase()
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value || defaultValue
  } catch {
    return defaultValue
  }
}

let WebSocketImpl: typeof WebSocket

async function getWebSocketImpl(): Promise<typeof WebSocket> {
  if (WebSocketImpl) return WebSocketImpl
  try {
    const { WebSocket: WsClass } = await import('ws' as any)
    WebSocketImpl = WsClass as unknown as typeof WebSocket
  } catch {
    WebSocketImpl = globalThis.WebSocket
  }
  return WebSocketImpl
}

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

export const bridgeEmitter = new EventEmitter()

function getLocalClientId(): string {
  try {
    const db = getDatabase()
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'device.client_id'`).get() as { value: string } | undefined
    if (row?.value) return row.value

    const { randomUUID } = require('crypto')
    const id = `mc-local-${randomUUID()}`
    try {
      db.prepare(`INSERT OR IGNORE INTO settings (key, value, category) VALUES ('device.client_id', ?, 'device')`).run(id)
      return id
    } catch {
      const { createHash } = require('crypto')
      const hostHash = createHash('md5').update(process.cwd()).digest('hex').substring(0, 8)
      return `mc-node-${hostHash}`
    }
  } catch {
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

function getLocalAgentList(): Array<{ id: number; name: string; role: string; status: string; framework?: string; parent_id?: number }> {
  try {
    const db = getDatabase()
    return db.prepare(
      `SELECT id, name, role, status, framework, parent_id FROM agents WHERE hidden = 0 ORDER BY name`
    ).all() as Array<{ id: number; name: string; role: string; status: string; framework?: string; parent_id?: number }>
  } catch {
    return []
  }
}

function safeSend(ws: WebSocket | null, data: object): boolean {
  if (!ws || ws.readyState !== 1) return false
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

/** True if non-empty and usable for bridge discovery or direct WS (avoids reconnect loops on typos). */
function isRecognizedBridgeUrl(value: string): boolean {
  const t = String(value || '').trim()
  if (!t) return false
  return isWebSocketUrl(t) || isHttpUrl(t)
}

async function resolveRemoteBridgeUrl(): Promise<{ wsUrl: string; discoverySource: string | null }> {
  let configured = REMOTE_SERVER_URL.trim()
  let token = REMOTE_SERVER_TOKEN.trim()

  if (!configured) {
    configured = getDbSetting('gateway.server_url').trim()
    token = getDbSetting('gateway.token').trim()
  }

  if (!configured) {
    throw new Error('Remote server URL not configured (via MC_REMOTE_SERVER_URL or settings)')
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

  const preview = configured.length > 96 ? `${configured.slice(0, 96)}…` : configured
  throw new Error(
    `MC_REMOTE_SERVER_URL / gateway.server_url must start with http://, https://, ws://, or wss:// (got: ${preview})`
  )
}

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

    let targetAgent: string | null = null
    if (assignTo) {
      const agentRow = db.prepare(
        `SELECT name FROM agents WHERE (name = ? OR id = ?) AND hidden = 0 LIMIT 1`
      ).get(assignTo, Number(assignTo) || 0) as { name: string } | undefined
      if (agentRow) {
        targetAgent = agentRow.name
      }
    }

    const status = targetAgent ? 'assigned' : 'inbox'
    const tagsJson = Array.isArray(tags) ? JSON.stringify(tags) : '[]'

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
      INSERT INTO tasks (title, description, status, priority, assigned_to, created_by, tags, metadata, workspace_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'remote-server', ?, ?, ?, ?, ?)
    `).run(
      String(title || 'Remote Task'),
      description ? String(description) : null,
      status,
      priority,
      targetAgent,
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
    const workspaceId = 1

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

    eventBus.broadcast('chat.message', { ...message, __from_bridge: true })
  } catch (err) {
    logger.error({ err }, '[RemoteBridge] Failed to handle incoming chat message')
  }
}

function handleCommand(payload: any): void {
  const { action } = payload || {}

  switch (action) {
    case 'agent_status_request': {
      const agents = getLocalAgentList()
      safeSend(state.ws, { type: 'agent_status', clientId: getLocalClientId(), clientLabel: getLocalClientLabel(), agents, timestamp: Date.now() })
      break
    }
    case 'ping_agents': {
      eventBus.broadcast('agent.synced' as any, { trigger: 'remote_command' })
      break
    }
    default:
      logger.warn({ action }, '[RemoteBridge] Unknown command action')
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
    default:
      if (type) {
        logger.debug({ type }, '[RemoteBridge] Unhandled message type')
      }
  }
}

const PING_INTERVAL_MS = 25_000
const MAX_PONG_SILENCE_MS = 90_000

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
    if (tickGap > PING_INTERVAL_MS * 2.5) {
      logger.warn({ tickGap }, '[RemoteBridge] Heartbeat gap (possible sleep) — probing connection')
      state.lastPong = now
      safeSend(state.ws, { type: 'ping', timestamp: now })
      return
    }
    if (now - state.lastPong > MAX_PONG_SILENCE_MS) {
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

async function connect(): Promise<void> {
  if (state.isShuttingDown) return
  if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) {
    return
  }

  const resolved = await resolveRemoteBridgeUrl()
  const url = new URL(resolved.wsUrl)
  
  let token = REMOTE_SERVER_TOKEN.trim()
  if (!token && !REMOTE_SERVER_URL) {
    token = getDbSetting('gateway.token').trim()
  }

  if (token) {
    url.searchParams.set('token', token)
  }

  const WS = await getWebSocketImpl()
  let ws: WebSocket

  try {
    const headers: Record<string, string> = {}
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }
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
    state.lastPong = Date.now()
    logger.info({ url: resolved.wsUrl, discoverySource: resolved.discoverySource }, '[RemoteBridge] Connected to remote server')

    // Trigger a full catch-up sync for historical data
    import('./gateway-sync').then(({ runServerGatewaySync }) => {
      runServerGatewaySync().catch(err => {
        logger.error({ err }, '[RemoteBridge] Catch-up sync failed')
      })
    })

    safeSend(ws, {
      type: 'hello',
      clientId,
      clientLabel,
      version: '1.0',
      capabilities: ['task_receive', 'agent_status', 'heartbeat', 'chat_sync', 'session_transcript'],
      agents: getLocalAgentList(),
      timestamp: Date.now(),
    })

    const chatHandler = (event: any) => {
      if (state.connected && !event.__from_bridge) {
        safeSend(ws, { type: 'chat_message', message: event })
      }
    }
    eventBus.on('chat.message', chatHandler)

    startHeartbeat()
    bridgeEmitter.emit('connected', { url: resolved.wsUrl, discoverySource: resolved.discoverySource })
    ;(ws as any)._chatHandler = chatHandler
  }

  ws.onmessage = (event: MessageEvent) => {
    handleMessage(typeof event.data === 'string' ? event.data : String(event.data))
  }

  ws.onerror = () => {
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

let _started = false

export function startRemoteBridge(): void {
  const url = (REMOTE_SERVER_URL || getDbSetting('gateway.server_url') || '').trim()
  if (!url) {
    logger.info('[RemoteBridge] Remote server URL not set — bridge disabled')
    return
  }
  if (!isRecognizedBridgeUrl(url)) {
    logger.warn(
      { url: url.length > 120 ? `${url.slice(0, 120)}…` : url },
      '[RemoteBridge] Invalid remote URL (need http(s):// or ws(s)://, e.g. http://127.0.0.1:5000) — bridge disabled; fix MC_REMOTE_SERVER_URL or settings gateway.server_url'
    )
    return
  }
  if (_started) return
  _started = true

  logger.info({ url }, '[RemoteBridge] Starting remote server bridge')
  connect().catch((e) => {
    logger.error({ err: e }, '[RemoteBridge] Initial connect failed')
    scheduleReconnect()
  })
}

export function stopRemoteBridge(): void {
  state.isShuttingDown = true
  stopHeartbeat()
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer)
    state.reconnectTimer = null
  }
  if (state.ws) {
    try { state.ws.close(1000, 'Server shutting down') } catch {}
    state.ws = null
  }
  state.resolvedUrl = ''
  state.discoverySource = null
  _started = false
  logger.info('[RemoteBridge] Bridge stopped')
}

export function restartRemoteBridge(): void {
  logger.info('[RemoteBridge] Restarting bridge...')
  stopRemoteBridge()
  // Brief delay to ensure cleanup
  setTimeout(() => {
    startRemoteBridge()
  }, 1000)
}

export function getRemoteBridgeStatus(): {
  enabled: boolean
  connected: boolean
  url: string
  configuredUrl: string
  discoverySource: string | null
  reconnectAttempts: number
  lastPong: number
} {
  const configUrl = (REMOTE_SERVER_URL || getDbSetting('gateway.server_url') || '').trim()
  return {
    enabled: Boolean(configUrl) && isRecognizedBridgeUrl(configUrl),
    connected: state.connected,
    url: state.resolvedUrl || configUrl,
    configuredUrl: configUrl,
    discoverySource: state.discoverySource,
    reconnectAttempts: state.reconnectAttempts,
    lastPong: state.lastPong,
  }
}

export function sendBridgeEvent(type: string, payload: object): boolean {
  return safeSend(state.ws, { type, ...payload, timestamp: Date.now() })
}
