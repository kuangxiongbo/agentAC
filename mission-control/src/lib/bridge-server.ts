import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { logger } from './logger'
import { eventBus } from './event-bus'
import { getDatabase } from './db'
import { config } from './config'
import type { LocalSessionTranscriptKind, TranscriptMessage } from './session-transcript'
import { notifySessionTranscriptUpdated } from './session-realtime'

let wss: WebSocketServer | null = (global as any)._mc_bridge_server || null
const bridgeServerMeta: { port: number | null; startedAt: number | null } =
  (global as any)._mc_bridge_server_meta || { port: null, startedAt: null }
const bridgeServerClients: Map<string, BridgeServerClientState> =
  (global as any)._mc_bridge_server_clients || new Map()
const bridgeServerSockets: Map<string, WebSocket> =
  (global as any)._mc_bridge_server_sockets || new Map()
const bridgePendingRequests: Map<string, PendingBridgeRequest> =
  (global as any)._mc_bridge_pending_requests || new Map()

;(global as any)._mc_bridge_server_meta = bridgeServerMeta
;(global as any)._mc_bridge_server_clients = bridgeServerClients
;(global as any)._mc_bridge_server_sockets = bridgeServerSockets
;(global as any)._mc_bridge_pending_requests = bridgePendingRequests

type BridgeClientKind = 'edge' | 'ui' | 'unknown'

interface BridgeServerClientState {
  connectionId: string
  clientId: string
  clientLabel: string
  kind: BridgeClientKind
  status: 'connecting' | 'connected'
  connectedAt: number
  lastSeenAt: number
  capabilities: string[]
  agentCount: number
  remoteAddress: string | null
}

type BridgePendingKind = 'transcript' | 'continue'

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
  const target = Array.from(bridgeServerClients.values())
    .filter((client) => client.clientId === clientId && client.kind === 'edge' && client.status === 'connected')
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

export interface BridgeServerStatusSnapshot {
  running: boolean
  port: number | null
  startedAt: number | null
  connectedClients: number
  clients: BridgeServerClientState[]
}

function getRemoteAddress(ws: WebSocket): string | null {
  const socket = (ws as any)?._socket as { remoteAddress?: string } | undefined
  return typeof socket?.remoteAddress === 'string' ? socket.remoteAddress : null
}

function registerConnection(ws: WebSocket): string {
  const connectionId = randomUUID()
  const now = Date.now()
  bridgeServerSockets.set(connectionId, ws)
  bridgeServerClients.set(connectionId, {
    connectionId,
    clientId: 'unknown',
    clientLabel: 'Awaiting hello',
    kind: 'unknown',
    status: 'connecting',
    connectedAt: now,
    lastSeenAt: now,
    capabilities: [],
    agentCount: 0,
    remoteAddress: getRemoteAddress(ws),
  })
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
  for (const [requestId, pending] of bridgePendingRequests.entries()) {
    if (pending.connectionId !== connectionId) continue
    clearTimeout(pending.timeout)
    bridgePendingRequests.delete(requestId)
    pending.reject(new Error(reason))
  }
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
  })
  return true
}

export function initBridgeServer(port: number = 5002) {
  if (wss) return
  
  try {
    // Check if the port is already in use by a previous version of the module
    wss = new WebSocketServer({ port })
    ;(global as any)._mc_bridge_server = wss
    bridgeServerMeta.port = port
    bridgeServerMeta.startedAt = Date.now()
    logger.info({ port }, '[BridgeServer] Started WebSocket bridge server')

    wss.on('connection', (ws: WebSocket) => {
      logger.info('[BridgeServer] New connection established')
      const connectionId = registerConnection(ws)
      let clientId = 'unknown'
      let clientLabel = 'unknown'
      let isUiClient = false

      // Support OpenClaw UI connecting as if this is a gateway
      ws.send(JSON.stringify({ 
        type: 'event', 
        event: 'connect.challenge', 
        payload: { nonce: Math.random().toString(36).substring(7) } 
      }))

      ws.on('message', async (data: string) => {
        try {
          const msg = JSON.parse(data.toString())
          const { type, method, payload, event } = msg

          // Handle OpenClaw UI Bridge Protocol (v2/v3)
          if (type === 'req' && method === 'connect') {
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
            case 'hello':
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
                await registerRemoteAgents(clientId, clientLabel, msg.agents)
              }
              // Push projects to the client so they have the same context
              await pushProjectsToClient(ws)
              break

            case 'ping':
              touchConnection(connectionId)
              ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }))
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
                await registerRemoteAgents(clientId, nextClientLabel, msg.agents)
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
          }
        } catch (err) {
          logger.error({ err }, '[BridgeServer] Failed to handle message')
        }
      })

      ws.on('close', () => {
        bridgeServerSockets.delete(connectionId)
        clearPendingRequestsForConnection(connectionId, 'Bridge client disconnected')
        bridgeServerClients.delete(connectionId)
        logger.info({ clientId }, '[BridgeServer] Client disconnected')
      })
    })

    wss.on('error', (err) => {
      logger.error({ err }, '[BridgeServer] WebSocket server error')
    })

  } catch (err) {
    logger.error({ err }, '[BridgeServer] Failed to start bridge server')
  }
}

async function registerRemoteAgents(clientId: string, clientLabel: string, agents: any[]) {
  try {
    const db = getDatabase()
    if (config.centralMode) {
      db.prepare(`DELETE FROM agents WHERE source = 'bridge' AND node_id = ?`).run(clientId)
      return
    }
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

export function getBridgeServerStatus(): BridgeServerStatusSnapshot {
  const clients = Array.from(bridgeServerClients.values())
    .filter((client) => client.kind !== 'ui')
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)

  return {
    running: Boolean(wss),
    port: bridgeServerMeta.port,
    startedAt: bridgeServerMeta.startedAt,
    connectedClients: clients.filter((client) => client.status === 'connected').length,
    clients,
  }
}

export function stopBridgeServer() {
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
  timeoutMs?: number
}): Promise<{ messages: TranscriptMessage[]; source: string }> {
  const { ws, connectionId } = findConnectedEdgeBridge(input.clientId)
  const requestId = randomUUID()
  const timeoutMs = Math.max(1000, input.timeoutMs || 15000)

  return await new Promise<{ messages: TranscriptMessage[]; source: string }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      bridgePendingRequests.delete(requestId)
      reject(new Error(`Timed out waiting for transcript from client ${input.clientId}`))
    }, timeoutMs)

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
  timeoutMs?: number
}): Promise<{ reply: string; sessionId: string | null; source: string }> {
  const { ws, connectionId } = findConnectedEdgeBridge(input.clientId)
  const requestId = randomUUID()
  const timeoutMs = Math.max(5000, input.timeoutMs || 180000)

  return await new Promise<{ reply: string; sessionId: string | null; source: string }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      bridgePendingRequests.delete(requestId)
      reject(new Error(`Timed out waiting for session continue from client ${input.clientId}`))
    }, timeoutMs)

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
        },
      }))
    } catch (error) {
      clearTimeout(timeout)
      bridgePendingRequests.delete(requestId)
      reject(error instanceof Error ? error : new Error('Failed to send session continue request'))
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
