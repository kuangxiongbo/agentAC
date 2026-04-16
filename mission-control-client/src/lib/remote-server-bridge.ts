/**
 * Remote Server Bridge — Server-side persistent WebSocket client
 *
 * Proactively connects this local Mission Control instance to a remote
 * Mission Control server so the server can push tasks down to local agents.
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
}

const state: BridgeState = {
  ws: null,
  reconnectTimer: null,
  pingTimer: null,
  reconnectAttempts: 0,
  isShuttingDown: false,
  connected: false,
  lastPong: 0,
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
    db.prepare(`INSERT OR IGNORE INTO settings (key, value, category) VALUES ('device.client_id', ?, 'device')`).run(id, 'device')
    return id
  } catch {
    return `mc-local-${Date.now()}`
  }
}

function getLocalAgentList(): Array<{ id: number; name: string; role: string; status: string }> {
  try {
    const db = getDatabase()
    return db.prepare(
      `SELECT id, name, role, status FROM agents WHERE hidden = 0 ORDER BY name`
    ).all() as Array<{ id: number; name: string; role: string; status: string }>
  } catch {
    return []
  }
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

function handleCommand(payload: any): void {
  const { action } = payload || {}

  switch (action) {
    case 'agent_status_request': {
      // Server is asking for current agent status
      const agents = getLocalAgentList()
      safeSend(state.ws, { type: 'agent_status', agents, timestamp: Date.now() })
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
      safeSend(state.ws, { type: 'agent_status', agents: getLocalAgentList(), timestamp: Date.now() })
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

  const url = new URL(REMOTE_SERVER_URL)

  // Attach token as query param if provided (simple auth; server can also check header)
  if (REMOTE_SERVER_TOKEN) {
    url.searchParams.set('token', REMOTE_SERVER_TOKEN)
  }

  const WS = await getWebSocketImpl()
  let ws: WebSocket

  try {
    const headers: Record<string, string> = {}
    if (REMOTE_SERVER_TOKEN) {
      headers['Authorization'] = `Bearer ${REMOTE_SERVER_TOKEN}`
    }
    // ws package accepts headers; native WebSocket does not (browser constraint)
    ws = new (WS as any)(url.toString(), [], { headers }) as WebSocket
  } catch {
    ws = new WS(url.toString()) as WebSocket
  }

  state.ws = ws
  const clientId = getLocalClientId()

  ws.onopen = () => {
    state.connected = true
    state.reconnectAttempts = 0
    logger.info({ url: REMOTE_SERVER_URL }, '[RemoteBridge] Connected to remote server')

    // Send hello handshake
    safeSend(ws, {
      type: 'hello',
      clientId,
      version: '1.0',
      capabilities: ['task_receive', 'agent_status', 'heartbeat'],
      agents: getLocalAgentList(),
      timestamp: Date.now(),
    })

    startHeartbeat()
    bridgeEmitter.emit('connected', { url: REMOTE_SERVER_URL })
  }

  ws.onmessage = (event: MessageEvent) => {
    handleMessage(typeof event.data === 'string' ? event.data : String(event.data))
  }

  ws.onerror = (event: Event) => {
    // ws package passes an ErrorEvent; just log that an error occurred
    logger.warn('[RemoteBridge] WebSocket error, will reconnect...')
    bridgeEmitter.emit('error', { message: 'WebSocket error' })
  }

  ws.onclose = (event: CloseEvent) => {
    state.connected = false
    state.ws = null
    stopHeartbeat()
    logger.info({ code: event?.code, reason: event?.reason }, '[RemoteBridge] Disconnected from remote server')
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
  if (!REMOTE_SERVER_URL) {
    logger.info('[RemoteBridge] MC_REMOTE_SERVER_URL not set — bridge disabled')
    return
  }
  if (_started) return
  _started = true

  logger.info({ url: REMOTE_SERVER_URL }, '[RemoteBridge] Starting remote server bridge')
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
  reconnectAttempts: number
  lastPong: number
} {
  return {
    enabled: Boolean(REMOTE_SERVER_URL),
    connected: state.connected,
    url: REMOTE_SERVER_URL,
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
