import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import type { VerifyClientCallbackAsync } from 'ws'
import { logger } from './logger'
import { eventBus } from './event-bus'
import { getDatabase } from './db'
import { config, BRIDGE_TOKEN } from './config'
import type { LocalSessionTranscriptKind, TranscriptMessage } from './session-transcript'
import { notifySessionTranscriptUpdated } from './session-realtime'
import { replaceBridgeAgentIndex, type BridgeAgentIndexInput } from './sync-agent-index'
import { cleanupDuplicateClientAgents, reconcileClientAgentInventory } from './sync-agent-inventory'
import { decidePermissionRequest, recordWorkerHumanReply, type PermissionRequestView } from './permission-requests'
import { forwardPermissionDecisionToExecApproval } from './permission-request-exec-bridge'
import type { LocalCliElevationGrantContext } from './local-cli-elevation-audit'
import type { HumanWatchEventView } from './human-watch-types'

let wss: WebSocketServer | null = (global as any)._mc_bridge_server || null
const bridgeServerMeta: { port: number | null; startedAt: number | null } =
  (global as any)._mc_bridge_server_meta || { port: null, startedAt: null }
const bridgeServerClients: Map<string, BridgeServerClientState> =
  (global as any)._mc_bridge_server_clients || new Map()
const bridgeServerSockets: Map<string, WebSocket> =
  (global as any)._mc_bridge_server_sockets || new Map()
const bridgePendingRequests: Map<string, PendingBridgeRequest> =
  (global as any)._mc_bridge_pending_requests || new Map()

/** Lifetime counters — survive hot-reload via global. */
interface BridgeServerMetrics {
  totalConnections: number
  totalDisconnections: number
  totalMessagesReceived: number
  totalMessagesSent: number
  totalPendingTimeouts: number
  totalStaleClosures: number
  totalSendFailures: number
}
const bridgeServerMetrics: BridgeServerMetrics =
  (global as any)._mc_bridge_server_metrics || {
    totalConnections: 0,
    totalDisconnections: 0,
    totalMessagesReceived: 0,
    totalMessagesSent: 0,
    totalPendingTimeouts: 0,
    totalStaleClosures: 0,
    totalSendFailures: 0,
  }

;(global as any)._mc_bridge_server_meta = bridgeServerMeta
;(global as any)._mc_bridge_server_clients = bridgeServerClients
;(global as any)._mc_bridge_server_sockets = bridgeServerSockets
;(global as any)._mc_bridge_pending_requests = bridgePendingRequests
;(global as any)._mc_bridge_server_metrics = bridgeServerMetrics

/** Server proactively pings edge clients to keep TCP/WebSocket warm. */
const BRIDGE_KEEPALIVE_SWEEP_MS = 30_000

/** Seconds a new connection has to send a `hello` message before being closed. */
const HELLO_TIMEOUT_MS = 10_000

/** Maximum in-flight pending requests — circuit breaker to prevent memory bloat. */
const MAX_PENDING_REQUESTS = 50

/** Maximum simultaneous WebSocket clients on the bridge port (hard system ceiling). */
const MAX_BRIDGE_CLIENTS = 100

/**
 * License-controlled edge client limit.
 * 0 = use MAX_BRIDGE_CLIENTS (no license restriction).
 * Updated at runtime via setMaxEdgeClientsLimit() when the effective license is resolved.
 */
let _licenseMaxEdgeClients: number =
  ((global as any)._mc_bridge_license_max_edge_clients as number | undefined) ?? 0
;(global as any)._mc_bridge_license_max_edge_clients = _licenseMaxEdgeClients

export function setMaxEdgeClientsLimit(max: number): void {
  const clamped = Number.isFinite(max) && max >= 0 ? Math.floor(max) : 0
  _licenseMaxEdgeClients = clamped
  ;(global as any)._mc_bridge_license_max_edge_clients = clamped
}

/** Maximum allowed WebSocket message size in bytes (4 MB). */
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024

/** Per-connection hello watchdog timers (cleared once hello is received). */
const bridgeHelloTimers: Map<string, NodeJS.Timeout> =
  (global as any)._mc_bridge_hello_timers || new Map()
;(global as any)._mc_bridge_hello_timers = bridgeHelloTimers

let bridgeKeepaliveTimer: ReturnType<typeof setInterval> | null = null

function bridgePortAlreadyInUse(port: number): boolean {
  try {
    const net = require('node:net') as typeof import('node:net')
    const tester = net.createServer()
    return new Promise<boolean>((resolve) => {
      tester.once('error', () => resolve(true))
      tester.once('listening', () => {
        tester.close(() => resolve(false))
      })
      tester.listen(port, '::')
    }) as unknown as boolean
  } catch {
    return false
  }
}

function getSettingValue(key: string): string {
  try {
    const db = getDatabase()
    const row = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(key) as { value?: string } | undefined
    return String(row?.value || '').trim()
  } catch {
    return ''
  }
}

/**
 * Read the expected bridge token.
 * Must match the token emitted by edge bootstrap: explicit bridge token first,
 * then the active API key. `gateway.token` is last for legacy single-node installs.
 */
function getExpectedBridgeToken(): string {
  if (BRIDGE_TOKEN) return BRIDGE_TOKEN
  const edgeBridgeToken = (process.env.MC_EDGE_BRIDGE_TOKEN || '').trim()
  if (edgeBridgeToken) return edgeBridgeToken
  const apiKey = getSettingValue('security.api_key') || (process.env.API_KEY || '').trim()
  if (apiKey) return apiKey
  return getSettingValue('gateway.token')
}

function allowAnonymousBridge(): boolean {
  return process.env.MC_BRIDGE_ALLOW_ANONYMOUS === '1'
}

/** Extract bearer token from Authorization header value. */
function parseBearerToken(header: string | undefined): string {
  if (!header) return ''
  const m = header.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : header.trim()
}

function isLiveEdgeConnection(client: BridgeServerClientState): boolean {
  if (client.kind === 'ui' || client.status !== 'connected') return false
  const ws = bridgeServerSockets.get(client.connectionId)
  return Boolean(ws && ws.readyState === WebSocket.OPEN)
}

/** 3 missed pings = stale (3 × 30s = 90s) */
const BRIDGE_PONG_STALE_MS = BRIDGE_KEEPALIVE_SWEEP_MS * 3

function pingEdgeClients() {
  const now = Date.now()
  for (const [connectionId, client] of bridgeServerClients.entries()) {
    if (!isLiveEdgeConnection(client)) continue
    const ws = bridgeServerSockets.get(connectionId)
    if (!ws) continue

    // Close connections that haven't responded to pings — catches TCP half-open after sleep
    const pongSilenceMs = now - client.lastPongAt
    if (pongSilenceMs > BRIDGE_PONG_STALE_MS) {
      bridgeServerMetrics.totalStaleClosures++
      logger.warn(
        { clientId: client.clientId, clientLabel: client.clientLabel, pongSilenceMs, remoteAddress: client.remoteAddress },
        '[BridgeServer] No pong from edge client — closing stale connection',
      )
      try { ws.close(4001, 'Pong timeout') } catch { /* ignore */ }
      continue
    }

    try {
      ws.send(JSON.stringify({ type: 'ping', timestamp: now }))
      bridgeServerMetrics.totalMessagesSent++
    } catch (err) {
      bridgeServerMetrics.totalSendFailures++
      logger.warn({ clientId: client.clientId, err }, '[BridgeServer] Keepalive ping failed — closing socket')
      try { ws.close(4002, 'Keepalive ping failed') } catch { /* ignore */ }
    }
  }
}

function startBridgeKeepalive() {
  if (bridgeKeepaliveTimer) return
  bridgeKeepaliveTimer = setInterval(pingEdgeClients, BRIDGE_KEEPALIVE_SWEEP_MS)
}

function stopBridgeKeepalive() {
  if (!bridgeKeepaliveTimer) return
  clearInterval(bridgeKeepaliveTimer)
  bridgeKeepaliveTimer = null
}

type BridgeClientKind = 'edge' | 'ui' | 'unknown'

interface BridgeServerClientState {
  connectionId: string
  clientId: string
  clientLabel: string
  kind: BridgeClientKind
  status: 'connecting' | 'connected'
  connectedAt: number
  lastSeenAt: number
  lastPongAt: number
  capabilities: string[]
  agentCount: number
  remoteAddress: string | null
}

type BridgePendingKind =
  | 'transcript'
  | 'continue'
  | 'agent_detail'
  | 'agents_by_session'
  | 'agent_session_update'
  | 'steward_create'
  | 'steward_update'
  | 'steward_delete'
  | 'steward_judge'
  | 'agent_message'

interface PendingBridgeRequest {
  requestId: string
  clientId: string
  connectionId: string
  timeout: NodeJS.Timeout
  kind: BridgePendingKind
  sessionKind?: BridgeSessionContinueKind
  sessionId?: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

function findConnectedEdgeBridge(clientId: string): { connectionId: string; ws: WebSocket } {
  // Circuit breaker: refuse new requests when the queue is full
  if (bridgePendingRequests.size >= MAX_PENDING_REQUESTS) {
    bridgeServerMetrics.totalPendingTimeouts++ // reuse counter — semantically same pressure
    logger.error(
      { pendingCount: bridgePendingRequests.size, max: MAX_PENDING_REQUESTS, clientId },
      '[BridgeServer] Pending request limit reached — circuit breaker active',
    )
    throw new Error(`Bridge request queue full (${bridgePendingRequests.size}/${MAX_PENDING_REQUESTS}) — try again shortly`)
  }

  const target = Array.from(bridgeServerClients.values())
    .filter((client) => client.clientId === clientId && client.kind === 'edge' && isLiveEdgeConnection(client))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0]

  if (!target) {
    throw new Error(`Remote client not connected: ${clientId}`)
  }

  const ws = bridgeServerSockets.get(target.connectionId)
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error(`Remote client socket unavailable: ${clientId}`)
  }

  return { connectionId: target.connectionId, ws }
}

function sendPermissionRequestToEdge(request: PermissionRequestView): void {
  const clientId = typeof request.client_id === 'string' ? request.client_id.trim() : ''
  if (!clientId) return
  try {
    const { ws } = findConnectedEdgeBridge(clientId)
    ws.send(JSON.stringify({
      type: 'permission_request_sync',
      request,
      timestamp: Date.now(),
    }))
  } catch (err) {
    logger.debug({ err, requestId: request.id, clientId }, '[BridgeServer] Permission request sync skipped')
  }
}

function sendHumanWatchEventToEdge(eventRow: HumanWatchEventView): void {
  const clientId = typeof eventRow.client_id === 'string' ? eventRow.client_id.trim() : ''
  if (!clientId) return
  try {
    const { ws } = findConnectedEdgeBridge(clientId)
    ws.send(JSON.stringify({
      type: 'human_watch_event_sync',
      event: eventRow,
      timestamp: Date.now(),
    }))
  } catch (err) {
    logger.debug({ err, eventId: eventRow.id, clientId }, '[BridgeServer] Human watch event sync skipped')
  }
}

function initPermissionBridgeSync(): void {
  const globalState = globalThis as typeof globalThis & { __permissionBridgeSyncStarted?: boolean }
  if (globalState.__permissionBridgeSyncStarted) return
  globalState.__permissionBridgeSyncStarted = true
  eventBus.on('server-event', (event) => {
    if (event.type !== 'permission.requested' && event.type !== 'permission.decided') return
    const request = event.data as PermissionRequestView | null
    if (!request || typeof request.id !== 'string') return
    sendPermissionRequestToEdge(request)
  })
}

function initHumanWatchEventBridgeSync(): void {
  const globalState = globalThis as typeof globalThis & { __humanWatchEventBridgeSyncStarted?: boolean }
  if (globalState.__humanWatchEventBridgeSyncStarted) return
  globalState.__humanWatchEventBridgeSyncStarted = true
  eventBus.on('server-event', (event) => {
    if (event.type !== 'human_watch.event') return
    const row = event.data as HumanWatchEventView | null
    if (!row || typeof row.id !== 'string') return
    sendHumanWatchEventToEdge(row)
  })
}

export interface BridgeClientHealthView {
  connectionId: string
  clientId: string
  clientLabel: string
  kind: BridgeClientKind
  status: 'connecting' | 'connected'
  connectedAt: number
  lastSeenAt: number
  lastPongAt: number
  pongSilenceMs: number
  capabilities: string[]
  agentCount: number
  remoteAddress: string | null
}

export interface BridgeServerStatusSnapshot {
  running: boolean
  port: number | null
  startedAt: number | null
  uptimeMs: number | null
  connectedClients: number
  pendingRequests: number
  clients: BridgeServerClientState[]
  health: BridgeClientHealthView[]
  metrics: BridgeServerMetrics
}

function getRemoteAddress(ws: WebSocket): string | null {
  const socket = (ws as any)?._socket as { remoteAddress?: string } | undefined
  return typeof socket?.remoteAddress === 'string' ? socket.remoteAddress : null
}

function registerConnection(ws: WebSocket): string {
  const connectionId = randomUUID()
  const now = Date.now()
  const remoteAddress = getRemoteAddress(ws)
  bridgeServerSockets.set(connectionId, ws)
  bridgeServerClients.set(connectionId, {
    connectionId,
    clientId: 'unknown',
    clientLabel: 'Awaiting hello',
    kind: 'unknown',
    status: 'connecting',
    connectedAt: now,
    lastSeenAt: now,
    lastPongAt: now,
    capabilities: [],
    agentCount: 0,
    remoteAddress,
  })
  bridgeServerMetrics.totalConnections++
  logger.info({ connectionId, remoteAddress, totalConnections: bridgeServerMetrics.totalConnections }, '[BridgeServer] New connection')
  return connectionId
}

function updateConnection(connectionId: string, patch: Partial<BridgeServerClientState>) {
  const current = bridgeServerClients.get(connectionId)
  if (!current) return
  bridgeServerClients.set(connectionId, { ...current, ...patch, lastSeenAt: Date.now() })
}

function touchConnection(connectionId: string) {
  updateConnection(connectionId, {})
}

function clearPendingRequestsForConnection(connectionId: string, reason: string) {
  let count = 0
  for (const [requestId, pending] of bridgePendingRequests.entries()) {
    if (pending.connectionId !== connectionId) continue
    clearTimeout(pending.timeout)
    bridgePendingRequests.delete(requestId)
    pending.reject(new Error(reason))
    count++
  }
  if (count > 0) {
    logger.warn(
      { connectionId, reason, abortedRequests: count },
      '[BridgeServer] Aborted pending requests due to disconnect',
    )
  }
}

/**
 * Creates a timeout callback that increments the metrics counter and emits a
 * structured warning log before rejecting the caller's promise.
 */
function makePendingTimeout(
  requestId: string,
  kind: BridgePendingKind,
  clientId: string,
  timeoutMs: number,
  reject: (e: Error) => void,
): NodeJS.Timeout {
  return setTimeout(() => {
    bridgePendingRequests.delete(requestId)
    bridgeServerMetrics.totalPendingTimeouts++
    logger.warn(
      { requestId, kind, clientId, timeoutMs },
      '[BridgeServer] Pending bridge request timed out',
    )
    reject(new Error(`Timed out waiting for ${kind} from client ${clientId}`))
  }, timeoutMs)
}

function resolvePendingRequest(msg: any) {
  const requestId = typeof msg?.requestId === 'string' ? msg.requestId : ''
  if (!requestId) return false

  const pending = bridgePendingRequests.get(requestId)
  if (!pending) return false

  clearTimeout(pending.timeout)
  bridgePendingRequests.delete(requestId)

  if (msg?.ok === false) {
    pending.reject(new Error(typeof msg?.error === 'string' ? msg.error : `Remote ${pending.kind} request failed`))
    return true
  }

  if (pending.kind === 'agent_detail') {
    pending.resolve({
      agent: msg?.agent && typeof msg.agent === 'object' ? msg.agent : null,
      source: typeof msg?.source === 'string' ? msg.source : 'bridge',
    })
    return true
  }

  if (pending.kind === 'agents_by_session') {
    pending.resolve({
      agents: Array.isArray(msg?.agents) ? msg.agents : [],
      source: typeof msg?.source === 'string' ? msg.source : 'bridge',
    })
    return true
  }

  if (pending.kind === 'agent_session_update') {
    pending.resolve({
      agent: msg?.agent && typeof msg.agent === 'object' ? msg.agent : null,
      source: typeof msg?.source === 'string' ? msg.source : 'bridge',
    })
    return true
  }

  if (pending.kind === 'steward_create') {
    pending.resolve({
      agent: msg?.agent && typeof msg.agent === 'object' ? msg.agent : null,
      sessionProvisioning: Boolean(msg?.sessionProvisioning),
      source: typeof msg?.source === 'string' ? msg.source : 'bridge',
    })
    return true
  }

  if (pending.kind === 'steward_update') {
    pending.resolve({
      agent: msg?.agent && typeof msg.agent === 'object' ? msg.agent : null,
      source: typeof msg?.source === 'string' ? msg.source : 'bridge',
    })
    return true
  }

  if (pending.kind === 'steward_delete') {
    pending.resolve({
      deleted: Boolean(msg?.deleted),
      name: typeof msg?.name === 'string' ? msg.name : '',
      source: typeof msg?.source === 'string' ? msg.source : 'bridge',
    })
    return true
  }

  if (pending.kind === 'steward_judge') {
    pending.resolve({
      reply: typeof msg?.reply === 'string' ? msg.reply : '',
      sessionId: typeof msg?.sessionId === 'string' ? msg.sessionId : '',
      source: typeof msg?.source === 'string' ? msg.source : 'bridge',
    })
    return true
  }

  if (pending.kind === 'agent_message') {
    pending.resolve({
      success: msg?.success === true,
      accepted: Boolean(msg?.accepted),
      delivered: Boolean(msg?.delivered),
      agent_id: typeof msg?.agent_id === 'number' ? msg.agent_id : null,
      agent_name: typeof msg?.agent_name === 'string' ? msg.agent_name : '',
      session_key: typeof msg?.session_key === 'string' ? msg.session_key : undefined,
      session_kind: typeof msg?.session_kind === 'string' ? msg.session_kind : undefined,
      queued_prompt: typeof msg?.queued_prompt === 'string' ? msg.queued_prompt : undefined,
      reply_preview: typeof msg?.reply_preview === 'string' ? msg.reply_preview : undefined,
      source: typeof msg?.source === 'string' ? msg.source : 'bridge',
    })
    return true
  }

  if (pending.kind === 'continue') {
    const resolvedSessionId = typeof msg?.sessionId === 'string' ? msg.sessionId : pending.sessionId || null
    if (pending.sessionKind && resolvedSessionId) {
      notifySessionTranscriptUpdated(pending.sessionKind, resolvedSessionId, 'bridge_continue')
    }
    pending.resolve({
      reply: typeof msg?.reply === 'string' ? msg.reply : '',
      sessionId: resolvedSessionId,
      source: typeof msg?.source === 'string' ? msg.source : 'bridge',
    })
    return true
  }

  pending.resolve({
    messages: Array.isArray(msg?.messages) ? msg.messages as TranscriptMessage[] : [],
    source: typeof msg?.source === 'string' ? msg.source : 'bridge',
    hasMoreOlder: Boolean(msg?.hasMoreOlder),
    nextOlderCursor: typeof msg?.nextOlderCursor === 'string' ? msg.nextOlderCursor : null,
    sourceMtimeMs: typeof msg?.sourceMtimeMs === 'number' ? msg.sourceMtimeMs : 0,
    sourceSize: typeof msg?.sourceSize === 'number' ? msg.sourceSize : 0,
  })
  return true
}

export function initBridgeServer(port: number = 5002) {
  if (wss) return
  if (bridgeServerMeta.port === port && bridgeServerMeta.startedAt) return

  try {
    // ── Token-based access control ──────────────────────────────────────────
    // verifyClient runs synchronously during the HTTP Upgrade handshake.
    // We accept the connection only when:
    //   a) The Authorization: Bearer <token> header matches the expected token, or
    //   b) MC_BRIDGE_ALLOW_ANONYMOUS=1 was explicitly set for an isolated deployment.
    // Legacy URL query-param tokens are intentionally NOT accepted here so
    // that clients that haven't been updated yet get a clear rejection rather
    // than silently passing an insecure path.
    const verifyClient: VerifyClientCallbackAsync = (info, cb) => {
      // Count non-UI connections (edge + unknown-pending). UI browser clients are excluded from the edge limit.
      const nonUiCount = Array.from(bridgeServerClients.values()).filter((c) => c.kind !== 'ui').length
      const effectiveMax = _licenseMaxEdgeClients > 0 ? Math.min(_licenseMaxEdgeClients, MAX_BRIDGE_CLIENTS) : MAX_BRIDGE_CLIENTS
      if (nonUiCount >= effectiveMax) {
        logger.warn(
          { remoteAddress: (info.req.socket as any)?.remoteAddress, current: nonUiCount, max: effectiveMax, licenseMax: _licenseMaxEdgeClients },
          '[BridgeServer] Rejected connection — max edge clients reached',
        )
        cb(false, 503, 'Too Many Connections')
        return
      }
      const expected = getExpectedBridgeToken()
      if (!expected) {
        if (allowAnonymousBridge()) {
          cb(true)
          return
        }
        logger.error(
          { remoteAddress: (info.req.socket as any)?.remoteAddress },
          '[BridgeServer] Rejected connection — bridge token is not configured',
        )
        cb(false, 503, 'Bridge token not configured')
        return
      }
      const provided = parseBearerToken(info.req.headers['authorization'] as string | undefined)
        || (info.req.headers['x-api-key'] as string | undefined || '').trim()
      if (provided && provided === expected) {
        cb(true)
      } else {
        logger.warn(
          { remoteAddress: (info.req.socket as any)?.remoteAddress },
          '[BridgeServer] Rejected connection — invalid or missing token',
        )
        cb(false, 401, 'Unauthorized')
      }
    }

    wss = new WebSocketServer({ port, verifyClient, maxPayload: MAX_PAYLOAD_BYTES })
    ;(global as any)._mc_bridge_server = wss
    bridgeServerMeta.port = port
    bridgeServerMeta.startedAt = Date.now()
    const expectedSet = Boolean(getExpectedBridgeToken())
    logger.info({ port, authEnabled: expectedSet }, '[BridgeServer] Started WebSocket bridge server')
    initPermissionBridgeSync()
    initHumanWatchEventBridgeSync()

    wss.on('connection', (ws: WebSocket) => {
      const socket = (ws as any)?._socket as { setKeepAlive?: (enable: boolean, initialDelay?: number) => void } | undefined
      socket?.setKeepAlive?.(true, 30_000)
      const connectionId = registerConnection(ws)
      let clientId = 'unknown'
      let clientLabel = 'unknown'
      let isUiClient = false

      // ── Hello handshake timeout ──────────────────────────────────────────
      // If a connected client does not send `hello` within HELLO_TIMEOUT_MS,
      // it is treated as a zombie (crashed, misbehaving, or probing) and closed.
      const helloTimer = setTimeout(() => {
        const client = bridgeServerClients.get(connectionId)
        if (client && client.status === 'connecting') {
          bridgeServerMetrics.totalStaleClosures++
          logger.warn(
            { connectionId, remoteAddress: client.remoteAddress },
            '[BridgeServer] Hello timeout — closing zombie connection',
          )
          try { ws.close(4007, 'Hello timeout') } catch { /* ignore */ }
        }
      }, HELLO_TIMEOUT_MS)
      bridgeHelloTimers.set(connectionId, helloTimer)

      // Support OpenClaw UI connecting as if this is a gateway
      ws.send(JSON.stringify({
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce: Math.random().toString(36).substring(7) },
      }))

      ws.on('message', async (data: string) => {
        bridgeServerMetrics.totalMessagesReceived++
        try {
          const msg = JSON.parse(data.toString())
          const { type, method, payload, event } = msg

          // Handle OpenClaw UI Bridge Protocol (v2/v3)
          if (type === 'req' && method === 'connect') {
            // UI client identified — clear zombie watchdog
            const uiHelloT = bridgeHelloTimers.get(connectionId)
            if (uiHelloT) { clearTimeout(uiHelloT); bridgeHelloTimers.delete(connectionId) }
            isUiClient = true
            clientId = msg.params?.client?.id || 'mc-ui'
            clientLabel = msg.params?.client?.name || clientId
            updateConnection(connectionId, {
              clientId,
              clientLabel,
              kind: 'ui',
              status: 'connected',
            })
            logger.info({ clientId }, '[BridgeServer] UI Handshake complete')
            ws.send(JSON.stringify({
              type: 'res',
              id: msg.id,
              ok: true,
              result: {
                protocol: 3,
                serverId: 'master-gateway',
                clientToken: 'bridge-token'
              }
            }))
            return
          }

          if (type === 'req' && method === 'ping') {
            touchConnection(connectionId)
            ws.send(JSON.stringify({ type: 'res', id: msg.id, ok: true }))
            return
          }

          // Handle standard Bridge Protocol
          switch (type) {
            case 'hello': {
              // Clear the zombie watchdog — legit client identified
              const helloT = bridgeHelloTimers.get(connectionId)
              if (helloT) { clearTimeout(helloT); bridgeHelloTimers.delete(connectionId) }

              clientId = msg.clientId || 'unknown'
              clientLabel = typeof msg.clientLabel === 'string' && msg.clientLabel.trim()
                ? msg.clientLabel.trim()
                : clientId
              updateConnection(connectionId, {
                clientId,
                clientLabel,
                kind: isUiClient ? 'ui' : 'edge',
                status: 'connected',
                capabilities: Array.isArray(msg.capabilities) ? msg.capabilities.filter((item: unknown): item is string => typeof item === 'string') : [],
                agentCount: Array.isArray(msg.agents) ? msg.agents.length : 0,
              })
              logger.info({ clientId, clientLabel, capabilities: msg.capabilities }, '[BridgeServer] Client hello received')
              ws.send(JSON.stringify({ type: 'welcome', serverId: 'master-server' }))
              if (Array.isArray(msg.agents)) {
                await ingestBridgeAgentList(clientId, clientLabel, msg.agents)
              }
              // Push projects to the client so they have the same context
              await pushProjectsToClient(ws)
              break
            }

            case 'ping':
              touchConnection(connectionId)
              ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }))
              break

            case 'pong':
              updateConnection(connectionId, { lastPongAt: Date.now() })
              break

            case 'agent_status':
              updateConnection(connectionId, {
                clientId,
                clientLabel,
                kind: isUiClient ? 'ui' : 'edge',
                status: 'connected',
                agentCount: Array.isArray(msg.agents) ? msg.agents.length : 0,
              })
              if (Array.isArray(msg.agents)) {
                const nextClientLabel = typeof msg.clientLabel === 'string' && msg.clientLabel.trim()
                  ? msg.clientLabel.trim()
                  : clientLabel
                updateConnection(connectionId, { clientLabel: nextClientLabel })
                await ingestBridgeAgentList(clientId, nextClientLabel, msg.agents)
              }
              break

            case 'chat_message':
              touchConnection(connectionId)
              if (msg.message) {
                try {
                  const db = getDatabase()
                  const workspaceId = 1
                  const m = msg.message
                  
                  // Check if message already exists (deduplication based on conv_id, content and timestamp)
                  const existing = db.prepare('SELECT id FROM messages WHERE conversation_id = ? AND content = ? AND created_at = ?')
                    .get(m.conversation_id, m.content, m.created_at)
                  
                  if (!existing) {
                    db.prepare(`
                      INSERT INTO messages (conversation_id, from_agent, to_agent, content, message_type, metadata, workspace_id, created_at, synced)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
                    `).run(
                      m.conversation_id,
                      m.from_agent,
                      m.to_agent || null,
                      m.content,
                      m.message_type || 'text',
                      m.metadata ? (typeof m.metadata === 'string' ? m.metadata : JSON.stringify(m.metadata)) : null,
                      workspaceId,
                      m.created_at || Math.floor(Date.now() / 1000)
                    )
                  }
                  
                  eventBus.broadcast('chat.message', { ...m, __from_bridge: true })
                } catch (err) {
                  logger.error({ err }, '[BridgeServer] Failed to persist incoming chat message')
                }
              }
              break

            case 'session_transcript_response':
            case 'session_continue_response':
            case 'agent_detail_response':
            case 'agents_by_session_response':
            case 'agent_session_update_response':
            case 'steward_create_response':
            case 'steward_update_response':
            case 'steward_delete_response':
            case 'steward_judge_response':
            case 'agent_message_response':
              touchConnection(connectionId)
              resolvePendingRequest(msg)
              break

            case 'session_transcript_changed': {
              touchConnection(connectionId)
              const edgeSession = msg?.session && typeof msg.session === 'object' ? msg.session : {}
              const edgeKind = typeof edgeSession?.kind === 'string' ? edgeSession.kind : ''
              const edgeSessionId = typeof edgeSession?.sessionId === 'string' ? edgeSession.sessionId : ''
              if (edgeKind && edgeSessionId) {
                notifySessionTranscriptUpdated(edgeKind, edgeSessionId, 'edge_transcript_changed')
              }
              break
            }

            case 'permission_decision_sync': {
              touchConnection(connectionId)
              const requestId = typeof msg?.requestId === 'string' ? msg.requestId : ''
              const optionId = typeof msg?.optionId === 'string' ? msg.optionId : ''
              if (!requestId || !optionId) {
                ws.send(JSON.stringify({
                  type: 'permission_decision_sync_response',
                  requestId,
                  ok: false,
                  error: 'requestId and optionId are required',
                }))
                break
              }
              try {
                const decided = decidePermissionRequest({
                  requestId,
                  workspaceId: 1,
                  optionId,
                  reason: typeof msg?.reason === 'string' ? msg.reason : null,
                  deciderType: 'steward_agent',
                  deciderAgentId:
                    typeof msg?.deciderAgentId === 'string'
                      ? msg.deciderAgentId
                      : typeof msg?.decider_agent_id === 'string'
                        ? msg.decider_agent_id
                        : null,
                })
                const option = decided.options.find((item) => item.id === optionId)
                let gatewayForward: Awaited<ReturnType<typeof forwardPermissionDecisionToExecApproval>> | null = null
                if (option) {
                  gatewayForward = await forwardPermissionDecisionToExecApproval({
                    request: decided,
                    option,
                    reason: typeof msg?.reason === 'string' ? msg.reason : null,
                  })
                }
                ws.send(JSON.stringify({
                  type: 'permission_decision_sync_response',
                  requestId,
                  ok: true,
                  request: decided,
                  ...(gatewayForward ? { gatewayForward } : {}),
                  ...(gatewayForward?.status === 'failed' ? { warning: gatewayForward.error } : {}),
                }))
              } catch (err) {
                ws.send(JSON.stringify({
                  type: 'permission_decision_sync_response',
                  requestId,
                  ok: false,
                  error: err instanceof Error ? err.message : 'Failed to sync permission decision',
                }))
              }
              break
            }

            case 'worker_human_reply_sync': {
              touchConnection(connectionId)
              const requestId = typeof msg?.requestId === 'string' ? msg.requestId : typeof msg?.request_id === 'string' ? msg.request_id : ''
              const selectedOptionId = typeof msg?.selectedOptionId === 'string'
                ? msg.selectedOptionId
                : typeof msg?.selected_option_id === 'string'
                  ? msg.selected_option_id
                  : typeof msg?.optionId === 'string'
                    ? msg.optionId
                    : ''
              if (!requestId || !selectedOptionId) {
                ws.send(JSON.stringify({
                  type: 'worker_human_reply_sync_response',
                  requestId,
                  ok: false,
                  error: 'requestId and selectedOptionId are required',
                }))
                break
              }
              try {
                const updated = recordWorkerHumanReply({
                  requestId,
                  workspaceId: 1,
                  clientNodeId: typeof msg?.clientNodeId === 'string' ? msg.clientNodeId : clientId,
                  sessionId: typeof msg?.sessionId === 'string' ? msg.sessionId : typeof msg?.session_id === 'string' ? msg.session_id : null,
                  messageId: typeof msg?.messageId === 'string' ? msg.messageId : typeof msg?.message_id === 'string' ? msg.message_id : null,
                  replyText: typeof msg?.replyText === 'string' ? msg.replyText : typeof msg?.reply_text === 'string' ? msg.reply_text : null,
                  selectedOptionId,
                  observedAt: typeof msg?.observedAt === 'string' ? msg.observedAt : typeof msg?.observed_at === 'string' ? msg.observed_at : null,
                  idempotencyKey: typeof msg?.idempotencyKey === 'string' ? msg.idempotencyKey : typeof msg?.idempotency_key === 'string' ? msg.idempotency_key : null,
                })
                ws.send(JSON.stringify({
                  type: 'worker_human_reply_sync_response',
                  requestId,
                  ok: true,
                  request: updated,
                }))
              } catch (err) {
                ws.send(JSON.stringify({
                  type: 'worker_human_reply_sync_response',
                  requestId,
                  ok: false,
                  error: err instanceof Error ? err.message : 'Failed to sync worker human reply',
                }))
              }
              break
            }
          }
        } catch (err) {
          logger.error({ err }, '[BridgeServer] Failed to handle message')
        }
      })

      ws.on('close', (code: number, reason: Buffer) => {
        const helloT = bridgeHelloTimers.get(connectionId)
        if (helloT) { clearTimeout(helloT); bridgeHelloTimers.delete(connectionId) }
        const client = bridgeServerClients.get(connectionId)
        const durationMs = client ? Date.now() - client.connectedAt : 0
        bridgeServerSockets.delete(connectionId)
        clearPendingRequestsForConnection(connectionId, 'Bridge client disconnected')
        bridgeServerClients.delete(connectionId)
        bridgeServerMetrics.totalDisconnections++
        logger.info(
          {
            clientId,
            clientLabel,
            kind: client?.kind ?? 'unknown',
            code,
            reason: reason?.toString() || '',
            durationMs,
            totalDisconnections: bridgeServerMetrics.totalDisconnections,
          },
          '[BridgeServer] Client disconnected',
        )
      })
    })

    wss.on('error', (err: any) => {
      if (err?.code === 'EADDRINUSE') {
        logger.warn({ err, port }, '[BridgeServer] Bridge port already in use; dev duplicate listener ignored')
        return
      }
      logger.error({ err }, '[BridgeServer] WebSocket server error')
    })

    startBridgeKeepalive()

  } catch (err: any) {
    if (err?.code === 'EADDRINUSE') {
      logger.warn({ err, port }, '[BridgeServer] Bridge port already in use; assuming an existing bridge server is active')
      bridgeServerMeta.port = port
      bridgeServerMeta.startedAt = bridgeServerMeta.startedAt || Date.now()
      return
    }
    logger.error({ err }, '[BridgeServer] Failed to start bridge server')
  }
}

function normalizeBridgeAgentList(agents: any[]): BridgeAgentIndexInput[] {
  return agents
    .filter((agent) => agent && typeof agent === 'object')
    .map((agent) => ({
      id: Number(agent.id),
      name: String(agent.name || '').trim(),
      role: String(agent.role || 'agent'),
      status: String(agent.status || 'idle'),
      framework: typeof agent.framework === 'string' ? agent.framework : null,
      parent_id: agent.parent_id == null ? null : Number(agent.parent_id),
      session_key:
        typeof agent.session_key === 'string' && agent.session_key.trim()
          ? agent.session_key.trim()
          : null,
    }))
    .filter((agent) => agent.name && Number.isFinite(agent.id))
}

async function ingestBridgeAgentList(clientId: string, clientLabel: string, agents: any[]) {
  try {
    const normalized = normalizeBridgeAgentList(agents)
    replaceBridgeAgentIndex(clientId, clientLabel, normalized)
    if (config.centralMode) {
      const inventory = normalized.map((agent) => ({
        local_agent_id: agent.id,
        original_name: agent.name,
        status: agent.status,
        role: agent.role,
        framework: agent.framework,
      }))
      reconcileClientAgentInventory(1, clientId, clientLabel, inventory)
      cleanupDuplicateClientAgents(1, clientId)
    } else {
      await registerRemoteAgents(clientId, clientLabel, normalized)
    }
  } catch (err) {
    logger.error({ err, clientId }, '[BridgeServer] Failed to ingest bridge agent list')
  }
}

async function registerRemoteAgents(clientId: string, clientLabel: string, agents: BridgeAgentIndexInput[]) {
  try {
    const db = getDatabase()
    const now = Math.floor(Date.now() / 1000)
    
    for (const agent of agents) {
      const fullAgentName = `${clientId}-${agent.name}`
      const configJson = JSON.stringify({
        node_label: clientLabel || clientId,
        bridge_client_id: clientId,
      })
      db.prepare(`
        INSERT INTO agents (name, role, status, source, last_seen, updated_at, workspace_id, node_id, framework, parent_id, config)
        VALUES (?, ?, ?, 'bridge', ?, ?, 1, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          role = excluded.role,
          status = excluded.status,
          last_seen = excluded.last_seen,
          updated_at = excluded.updated_at,
          node_id = excluded.node_id,
          framework = excluded.framework,
          parent_id = excluded.parent_id,
          config = excluded.config
      `).run(
        fullAgentName, 
        agent.role || 'remote agent', 
        agent.status || 'idle', 
        now, 
        now, 
        clientId,
        agent.framework || 'openclaw',
        agent.parent_id || null,
        configJson
      )
    }
  } catch (err) {
    logger.error({ err }, '[BridgeServer] Failed to register remote agents')
  }
}

export function isBridgeClientOnline(clientId: string): boolean {
  return Array.from(bridgeServerClients.values()).some(
    (client) => client.clientId === clientId && isLiveEdgeConnection(client),
  )
}

export function getBridgeServerStatus(): BridgeServerStatusSnapshot {
  const now = Date.now()
  const clients = Array.from(bridgeServerClients.values())
    .filter((client) => client.kind !== 'ui')
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)

  const health: BridgeClientHealthView[] = clients.map((client) => ({
    connectionId: client.connectionId,
    clientId: client.clientId,
    clientLabel: client.clientLabel,
    kind: client.kind,
    status: client.status,
    connectedAt: client.connectedAt,
    lastSeenAt: client.lastSeenAt,
    lastPongAt: client.lastPongAt,
    pongSilenceMs: now - client.lastPongAt,
    capabilities: client.capabilities,
    agentCount: client.agentCount,
    remoteAddress: client.remoteAddress,
  }))

  return {
    running: Boolean(wss),
    port: bridgeServerMeta.port,
    startedAt: bridgeServerMeta.startedAt,
    uptimeMs: bridgeServerMeta.startedAt ? now - bridgeServerMeta.startedAt : null,
    connectedClients: clients.filter((client) => isLiveEdgeConnection(client)).length,
    pendingRequests: bridgePendingRequests.size,
    clients,
    health,
    metrics: { ...bridgeServerMetrics },
  }
}

export function stopBridgeServer() {
  stopBridgeKeepalive()
  if (wss) {
    for (const pending of bridgePendingRequests.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Bridge server stopped'))
    }
    bridgePendingRequests.clear()
    bridgeServerSockets.clear()
    wss.close()
    wss = null
    bridgeServerMeta.startedAt = null
    bridgeServerClients.clear()
    logger.info('[BridgeServer] Stopped')
  }
}

export async function requestBridgeClientSessionTranscript(input: {
  clientId: string
  kind: LocalSessionTranscriptKind
  sessionId: string
  limit: number
  before?: string
  timeoutMs?: number
}): Promise<{
  messages: TranscriptMessage[]
  source: string
  hasMoreOlder?: boolean
  nextOlderCursor?: string | null
  sourceMtimeMs?: number
  sourceSize?: number
}> {
  const { ws, connectionId } = findConnectedEdgeBridge(input.clientId)
  const requestId = randomUUID()
  const timeoutMs = Math.max(1000, input.timeoutMs || 15000)

  return await new Promise<{
    messages: TranscriptMessage[]
    source: string
    hasMoreOlder?: boolean
    nextOlderCursor?: string | null
    sourceMtimeMs?: number
    sourceSize?: number
  }>((resolve, reject) => {
    const timeout = makePendingTimeout(requestId, 'transcript', input.clientId, timeoutMs, reject)

    bridgePendingRequests.set(requestId, {
      requestId,
      clientId: input.clientId,
      connectionId,
      timeout,
      kind: 'transcript',
      resolve: resolve as (value: unknown) => void,
      reject,
    })

    try {
      ws.send(JSON.stringify({
        type: 'session_transcript_request',
        requestId,
        session: {
          kind: input.kind,
          sessionId: input.sessionId,
          limit: input.limit,
          ...(input.before ? { before: input.before } : {}),
        },
      }))
    } catch (error) {
      clearTimeout(timeout)
      bridgePendingRequests.delete(requestId)
      reject(error instanceof Error ? error : new Error('Failed to send transcript request'))
    }
  })
}

export type BridgeSessionContinueKind = LocalSessionTranscriptKind | 'cursor' | 'opencode'

export async function requestBridgeClientSessionContinue(input: {
  clientId: string
  kind: BridgeSessionContinueKind
  sessionId: string
  prompt: string
  workingDirectory?: string | null
  localCliElevated?: boolean
  elevationGrant?: LocalCliElevationGrantContext | null
  timeoutMs?: number
}): Promise<{ reply: string; sessionId: string | null; source: string }> {
  const { ws, connectionId } = findConnectedEdgeBridge(input.clientId)
  const requestId = randomUUID()
  const timeoutMs = Math.max(5000, input.timeoutMs || 180000)

  return await new Promise<{ reply: string; sessionId: string | null; source: string }>((resolve, reject) => {
    const timeout = makePendingTimeout(requestId, 'continue', input.clientId, timeoutMs, reject)

    bridgePendingRequests.set(requestId, {
      requestId,
      clientId: input.clientId,
      connectionId,
      timeout,
      kind: 'continue',
      sessionKind: input.kind,
      sessionId: input.sessionId,
      resolve: resolve as (value: unknown) => void,
      reject,
    })

    try {
      ws.send(JSON.stringify({
        type: 'session_continue_request',
        requestId,
        session: {
          kind: input.kind,
          sessionId: input.sessionId,
          prompt: input.prompt,
          ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {}),
          ...(input.localCliElevated ? { localCliElevated: true } : {}),
          ...(input.elevationGrant ? { elevationGrant: input.elevationGrant } : {}),
        },
      }))
    } catch (error) {
      clearTimeout(timeout)
      bridgePendingRequests.delete(requestId)
      reject(error instanceof Error ? error : new Error('Failed to send session continue request'))
    }
  })
}

export async function requestBridgeClientAgentsBySession(input: {
  clientId: string
  sessionId: string
  sessionKey?: string
  timeoutMs?: number
}): Promise<{
  agents: Array<{
    id: number
    name: string
    role: string
    session_key: string | null
    framework: string | null
    workspace_path: string | null
    status: string
  }>
  source: string
}> {
  const { ws, connectionId } = findConnectedEdgeBridge(input.clientId)
  const requestId = randomUUID()
  const timeoutMs = Math.max(1000, input.timeoutMs || 12000)

  return new Promise<{
    agents: Array<{
      id: number
      name: string
      role: string
      session_key: string | null
      framework: string | null
      workspace_path: string | null
      status: string
    }>
    source: string
  }>((resolve, reject) => {
    const timeout = makePendingTimeout(requestId, 'agents_by_session', input.clientId, timeoutMs, reject)

    bridgePendingRequests.set(requestId, {
      requestId,
      clientId: input.clientId,
      connectionId,
      timeout,
      kind: 'agents_by_session',
      resolve: resolve as (value: unknown) => void,
      reject,
    })

    try {
      ws.send(JSON.stringify({
        type: 'agents_by_session_request',
        requestId,
        sessionId: input.sessionId,
        sessionKey: input.sessionKey || '',
      }))
    } catch (error) {
      clearTimeout(timeout)
      bridgePendingRequests.delete(requestId)
      reject(error instanceof Error ? error : new Error('Failed to send agents-by-session request'))
    }
  })
}

export async function requestBridgeClientAgentSessionUpdate(input: {
  clientId: string
  localAgentId: number
  sessionKey: string
  sessionKind?: string
  timeoutMs?: number
}): Promise<{ agent: Record<string, unknown> | null; source: string }> {
  const { ws, connectionId } = findConnectedEdgeBridge(input.clientId)
  const requestId = randomUUID()
  const timeoutMs = Math.max(1000, input.timeoutMs || 12000)

  return await new Promise<{ agent: Record<string, unknown> | null; source: string }>((resolve, reject) => {
    const timeout = makePendingTimeout(requestId, 'agent_session_update', input.clientId, timeoutMs, reject)

    bridgePendingRequests.set(requestId, {
      requestId,
      clientId: input.clientId,
      connectionId,
      timeout,
      kind: 'agent_session_update',
      resolve: resolve as (value: unknown) => void,
      reject,
    })

    try {
      ws.send(JSON.stringify({
        type: 'agent_session_update_request',
        requestId,
        localAgentId: input.localAgentId,
        sessionKey: input.sessionKey,
        sessionKind: input.sessionKind || '',
      }))
    } catch (error) {
      clearTimeout(timeout)
      bridgePendingRequests.delete(requestId)
      reject(error instanceof Error ? error : new Error('Failed to send agent session update request'))
    }
  })
}

export type BridgeStewardCreateFramework = 'claude-code' | 'codex-cli'

export async function requestBridgeClientStewardCreate(input: {
  clientId: string
  name: string
  framework: BridgeStewardCreateFramework
  soulContent?: string | null
  workspacePath?: string | null
  authorized?: boolean
  timeoutMs?: number
}): Promise<{
  agent: Record<string, unknown> | null
  sessionProvisioning: boolean
  source: string
}> {
  const { ws, connectionId } = findConnectedEdgeBridge(input.clientId)
  const requestId = randomUUID()
  const timeoutMs = Math.max(5000, input.timeoutMs || 120000)

  return await new Promise<{
    agent: Record<string, unknown> | null
    sessionProvisioning: boolean
    source: string
  }>((resolve, reject) => {
    const timeout = makePendingTimeout(requestId, 'steward_create', input.clientId, timeoutMs, reject)

    bridgePendingRequests.set(requestId, {
      requestId,
      clientId: input.clientId,
      connectionId,
      timeout,
      kind: 'steward_create',
      resolve: resolve as (value: unknown) => void,
      reject,
    })

    try {
      ws.send(JSON.stringify({
        type: 'steward_create_request',
        requestId,
        authorized: input.authorized !== false,
        steward: {
          name: input.name,
          framework: input.framework,
          soul_content: input.soulContent || '',
          workspace_path: input.workspacePath || '',
        },
      }))
    } catch (error) {
      clearTimeout(timeout)
      bridgePendingRequests.delete(requestId)
      reject(error instanceof Error ? error : new Error('Failed to send steward create request'))
    }
  })
}

export async function requestBridgeClientStewardUpdate(input: {
  clientId: string
  localAgentId: number
  name?: string | null
  soulContent?: string | null
  configPatch?: Record<string, unknown> | null
  timeoutMs?: number
}): Promise<{ agent: Record<string, unknown> | null; source: string }> {
  const { ws, connectionId } = findConnectedEdgeBridge(input.clientId)
  const requestId = randomUUID()
  const timeoutMs = Math.max(5000, input.timeoutMs || 60000)

  return await new Promise<{ agent: Record<string, unknown> | null; source: string }>(
    (resolve, reject) => {
      const timeout = makePendingTimeout(requestId, 'steward_update', input.clientId, timeoutMs, reject)

      bridgePendingRequests.set(requestId, {
        requestId,
        clientId: input.clientId,
        connectionId,
        timeout,
        kind: 'steward_update',
        resolve: resolve as (value: unknown) => void,
        reject,
      })

      try {
        ws.send(
          JSON.stringify({
            type: 'steward_update_request',
            requestId,
            localAgentId: input.localAgentId,
            steward: {
              name: input.name ?? undefined,
              soul_content: input.soulContent ?? undefined,
              config_patch: input.configPatch ?? undefined,
            },
          }),
        )
      } catch (error) {
        clearTimeout(timeout)
        bridgePendingRequests.delete(requestId)
        reject(
          error instanceof Error ? error : new Error('Failed to send steward update request'),
        )
      }
    },
  )
}

export async function requestBridgeClientStewardDelete(input: {
  clientId: string
  localAgentId: number
  timeoutMs?: number
}): Promise<{ deleted: boolean; name: string; source: string }> {
  const { ws, connectionId } = findConnectedEdgeBridge(input.clientId)
  const requestId = randomUUID()
  const timeoutMs = Math.max(5000, input.timeoutMs || 60000)

  return await new Promise<{ deleted: boolean; name: string; source: string }>(
    (resolve, reject) => {
      const timeout = makePendingTimeout(requestId, 'steward_delete', input.clientId, timeoutMs, reject)

      bridgePendingRequests.set(requestId, {
        requestId,
        clientId: input.clientId,
        connectionId,
        timeout,
        kind: 'steward_delete',
        resolve: resolve as (value: unknown) => void,
        reject,
      })

      try {
        ws.send(
          JSON.stringify({
            type: 'steward_delete_request',
            requestId,
            localAgentId: input.localAgentId,
          }),
        )
      } catch (error) {
        clearTimeout(timeout)
        bridgePendingRequests.delete(requestId)
        reject(
          error instanceof Error ? error : new Error('Failed to send steward delete request'),
        )
      }
    },
  )
}

export async function requestBridgeClientStewardJudge(input: {
  clientId: string
  localAgentId: number
  prompt: string
  timeoutMs?: number
}): Promise<{ reply: string; sessionId: string; source: string }> {
  const { ws, connectionId } = findConnectedEdgeBridge(input.clientId)
  const requestId = randomUUID()
  const timeoutMs = Math.max(5000, input.timeoutMs || 180000)

  return await new Promise<{ reply: string; sessionId: string; source: string }>((resolve, reject) => {
    const timeout = makePendingTimeout(requestId, 'steward_judge', input.clientId, timeoutMs, reject)

    bridgePendingRequests.set(requestId, {
      requestId,
      clientId: input.clientId,
      connectionId,
      timeout,
      kind: 'steward_judge',
      resolve: resolve as (value: unknown) => void,
      reject,
    })

    try {
      ws.send(JSON.stringify({
        type: 'steward_judge_request',
        requestId,
        localAgentId: input.localAgentId,
        prompt: input.prompt,
      }))
    } catch (error) {
      clearTimeout(timeout)
      bridgePendingRequests.delete(requestId)
      reject(error instanceof Error ? error : new Error('Failed to send steward judge request'))
    }
  })
}

export type BridgeAgentMessageResult = {
  success: boolean
  accepted: boolean
  delivered: boolean
  agent_id: number | null
  agent_name: string
  session_key?: string
  session_kind?: string
  queued_prompt?: string
  reply_preview?: string
  source: string
}

export async function requestBridgeClientAgentMessage(input: {
  clientId: string
  localAgentId: number
  message: string
  from: string
  localCliElevated?: boolean
  elevationGrant?: LocalCliElevationGrantContext | null
  timeoutMs?: number
}): Promise<BridgeAgentMessageResult> {
  const { ws, connectionId } = findConnectedEdgeBridge(input.clientId)
  const requestId = randomUUID()
  const timeoutMs = Math.max(5000, input.timeoutMs || 300_000)

  return await new Promise<BridgeAgentMessageResult>((resolve, reject) => {
    const timeout = makePendingTimeout(requestId, 'agent_message', input.clientId, timeoutMs, reject)

    bridgePendingRequests.set(requestId, {
      requestId,
      clientId: input.clientId,
      connectionId,
      timeout,
      kind: 'agent_message',
      resolve: resolve as (value: unknown) => void,
      reject,
    })

    try {
      ws.send(
        JSON.stringify({
          type: 'agent_message_request',
          requestId,
          localAgentId: input.localAgentId,
          message: input.message,
          from: input.from,
          ...(input.localCliElevated ? { localCliElevated: true } : {}),
          ...(input.elevationGrant ? { elevationGrant: input.elevationGrant } : {}),
        }),
      )
    } catch (error) {
      clearTimeout(timeout)
      bridgePendingRequests.delete(requestId)
      reject(error instanceof Error ? error : new Error('Failed to send agent message request'))
    }
  })
}

export async function requestBridgeClientAgentDetail(input: {
  clientId: string
  localAgentId: number
  timeoutMs?: number
}): Promise<{ agent: Record<string, unknown> | null; source: string }> {
  const { ws, connectionId } = findConnectedEdgeBridge(input.clientId)
  const requestId = randomUUID()
  const timeoutMs = Math.max(1000, input.timeoutMs || 12000)

  return await new Promise<{ agent: Record<string, unknown> | null; source: string }>((resolve, reject) => {
    const timeout = makePendingTimeout(requestId, 'agent_detail', input.clientId, timeoutMs, reject)

    bridgePendingRequests.set(requestId, {
      requestId,
      clientId: input.clientId,
      connectionId,
      timeout,
      kind: 'agent_detail',
      resolve: resolve as (value: unknown) => void,
      reject,
    })

    try {
      ws.send(JSON.stringify({
        type: 'agent_detail_request',
        requestId,
        localAgentId: input.localAgentId,
      }))
    } catch (error) {
      clearTimeout(timeout)
      bridgePendingRequests.delete(requestId)
      reject(error instanceof Error ? error : new Error('Failed to send agent detail request'))
    }
  })
}

/**
 * Push a task down to a connected bridge client.
 * Called by the task-dispatch scheduler when a task is assigned to a remote agent.
 */
export async function dispatchTaskToBridgeClient(task: any) {
  const clientId = task.agent_node_id
  if (!clientId) {
    throw new Error('Task has no agent_node_id — cannot dispatch to bridge')
  }

  // Find connectionId for this clientId
  const clientState = Array.from(bridgeServerClients.values())
    .find(c => c.clientId === clientId && c.status === 'connected')
  
  if (!clientState) {
    throw new Error(`Remote client not connected: ${clientId}`)
  }

  const ws = bridgeServerSockets.get(clientState.connectionId)
  if (!ws || ws.readyState !== 1 /* OPEN */) {
    throw new Error(`Remote client socket unavailable: ${clientId}`)
  }

  // Strip the node prefix from the assigned_to name if present (e.g. "nodeA-agent" -> "agent")
  let localAgentName = task.assigned_to
  if (localAgentName && localAgentName.startsWith(`${clientId}-`)) {
    localAgentName = localAgentName.substring(clientId.length + 1)
  }

  logger.info({ taskId: task.id, clientId, localAgentName }, '[BridgeServer] Dispatching task to remote client')

  ws.send(JSON.stringify({
    type: 'task_dispatch',
    task: {
      taskId: task.id,
      title: task.title,
      description: task.description,
      priority: task.priority,
      assignTo: localAgentName,
      projectId: task.project_id,
      projectTicketNo: task.project_ticket_no,
      tags: task.tags,
      metadata: typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {})
    }
  }))

  return true
}

async function pushProjectsToClient(ws: WebSocket) {
  try {
    const db = getDatabase()
    const projects = db.prepare(`
      SELECT id, name, slug, description, ticket_prefix, ticket_counter, status, workspace_id
      FROM projects
      WHERE status = 'active'
    `).all()
    
    ws.send(JSON.stringify({
      type: 'projects_sync',
      projects
    }))
  } catch (err) {
    logger.error({ err }, '[BridgeServer] Failed to push projects to client')
  }
}
