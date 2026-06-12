/**
 * Helpers for agent card display — extracted for testability.
 */

import {
  getMainAgentRuntimeMeta,
  isRuntimeManagedAgent,
  listMainAgentRuntimeMeta,
  type MainAgentRuntimeId,
} from '@/lib/runtime-agents'
import { isHumanWatchAgent } from '@/lib/human-watch-helpers'

export { isHumanWatchAgent }

export function readAgentConfigRecord(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {}
  return config as Record<string, unknown>
}

/** Prefer edge original_name over mc-local-{clientId}-{name} remote aliases. */
/** Match agent.session_key to CLI session id/key (incl. center synced composite list ids). */
export function findAgentBoundToSessionRecord<T extends { session_key?: string | null }>(
  agents: T[],
  session: { id?: string; sessionId?: string; key?: string },
): T | undefined {
  const keys = new Set<string>()
  for (const value of [session.sessionId, session.id, session.key]) {
    const trimmed = String(value || '').trim()
    if (trimmed) keys.add(trimmed)
  }
  if (keys.size === 0) return undefined
  return agents.find((agent) => {
    const bound = String(agent.session_key || '').trim()
    return bound.length > 0 && keys.has(bound)
  })
}

export function getAgentDisplayName(agent: {
  name: string
  config?: unknown
  source?: string
  node_id?: string | null
}): string {
  const config = readAgentConfigRecord(agent.config)
  const originalName = typeof config.original_name === 'string' ? config.original_name.trim() : ''
  if (originalName) return originalName

  const nodeId =
    (typeof agent.node_id === 'string' && agent.node_id) ||
    (typeof config.bridge_client_id === 'string' ? config.bridge_client_id : '')
  if (nodeId && agent.name.startsWith(`${nodeId}-`)) {
    const stripped = agent.name.slice(nodeId.length + 1).trim()
    if (stripped) return stripped
  }
  const syncClient = typeof config.sync_client_id === 'string' ? config.sync_client_id.trim() : ''
  if (syncClient && agent.name.startsWith(`${syncClient}-`)) {
    const stripped = agent.name.slice(syncClient.length + 1).trim()
    if (stripped) return stripped
  }
  return agent.name
}

export function getAgentClientId(agent: {
  node_id?: string | null
  config?: unknown
  bridge_client_id?: string | null
}): string | null {
  const topLevel =
    typeof agent.bridge_client_id === 'string' && agent.bridge_client_id.trim()
      ? agent.bridge_client_id.trim()
      : ''
  const config = readAgentConfigRecord(agent.config)
  const nodeId =
    topLevel ||
    (typeof agent.node_id === 'string' && agent.node_id.trim()) ||
    (typeof config.bridge_client_id === 'string' ? config.bridge_client_id.trim() : '') ||
    (typeof config.sync_client_id === 'string' ? config.sync_client_id.trim() : '')
  return nodeId || null
}

/** Edge local agent id for bridge_index rows; falls back to DB id for local agents. */
export function getAgentLocalAgentId(agent: {
  id?: number
  source?: string
  node_id?: string | null
  config?: unknown
  edge_local_agent_id?: number | null
}): number | null {
  if (typeof agent.edge_local_agent_id === 'number' && Number.isFinite(agent.edge_local_agent_id)) {
    return agent.edge_local_agent_id
  }
  const config = readAgentConfigRecord(agent.config)
  const fromConfig = config.local_agent_id
  if (typeof fromConfig === 'number' && Number.isFinite(fromConfig)) return fromConfig
  if (agent.source === 'bridge_index' || agent.source === 'client') return null
  if (typeof agent.id === 'number' && Number.isFinite(agent.id)) return agent.id
  return null
}

/** sync_agent_index row id for bridge_index list/detail rows. */
export function getAgentBridgeSyncIndexId(agent: {
  id?: number
  source?: string
}): number | null {
  if (agent.source === 'bridge_index' && typeof agent.id === 'number' && Number.isFinite(agent.id)) {
    return agent.id
  }
  return null
}

export function humanWatchBindingMatchesWorker(
  binding: {
    worker_local_agent_id: number | null
    worker_sync_index_id?: number | null
  },
  agent: {
    id?: number
    source?: string
    config?: unknown
    edge_local_agent_id?: number | null
    bridge_client_id?: string | null
    node_id?: string | null
  },
  resolved?: { local_agent_id: number | null; sync_index_id: number | null },
): boolean {
  const localId = resolved?.local_agent_id ?? getAgentLocalAgentId(agent)
  if (localId != null && binding.worker_local_agent_id === localId) return true
  const syncId = resolved?.sync_index_id ?? getAgentBridgeSyncIndexId(agent)
  if (syncId != null && binding.worker_sync_index_id === syncId) return true
  return false
}

export function humanWatchBindingMatchesSteward(
  binding: {
    steward_local_agent_id: number | null
    steward_sync_index_id?: number | null
  },
  agent: {
    id?: number
    source?: string
    config?: unknown
    edge_local_agent_id?: number | null
  },
  resolved?: { local_agent_id: number | null; sync_index_id: number | null },
): boolean {
  const localId = resolved?.local_agent_id ?? getAgentLocalAgentId(agent)
  if (localId != null && binding.steward_local_agent_id === localId) return true
  const syncId = resolved?.sync_index_id ?? getAgentBridgeSyncIndexId(agent)
  if (syncId != null && binding.steward_sync_index_id === syncId) return true
  return false
}

export function resolveHumanWatchStewardLabel(
  binding: { steward_name?: string | null; steward_local_agent_id: number | null },
  allAgents: Array<{
    name: string
    config?: unknown
    node_id?: string | null
    source?: string
    framework?: string | null
  }>,
  clientId: string,
): string {
  const stored = String(binding.steward_name || '').trim()
  if (stored) return stored
  if (binding.steward_local_agent_id == null) return '—'
  const steward = allAgents.find(
    (a) =>
      getAgentClientId(a) === clientId &&
      getAgentLocalAgentId(a) === binding.steward_local_agent_id,
  )
  if (steward) return getAgentDisplayName(steward)
  return `#${binding.steward_local_agent_id}`
}

export function getAgentClientLabel(
  agent: { config?: unknown; node_id?: string | null },
  clientNameById?: Map<string, string>,
): string | null {
  const config = readAgentConfigRecord(agent.config)
  if (typeof config.node_label === 'string' && config.node_label.trim()) {
    return config.node_label.trim()
  }
  const clientId = getAgentClientId(agent)
  if (clientId && clientNameById?.has(clientId)) {
    return clientNameById.get(clientId) || clientId
  }
  return clientId
}

/** Runtime IDE anchor agents (e.g. Claude Code (Main)) — not used for dispatch. */
export function isRuntimeMainAnchorAgent(agent: {
  name?: string
  role?: string
  config?: unknown
  source?: string
  node_id?: string | null
}): boolean {
  if (isRuntimeManagedAgent(agent)) return true
  if (agent.role === 'main-agent') return true
  const display = getAgentDisplayName({
    name: agent.name || '',
    config: agent.config,
    source: agent.source,
    node_id: agent.node_id,
  })
  if (/\(Main\)/i.test(display)) return true
  return listMainAgentRuntimeMeta().some(
    (meta) => display === meta.mainAgentName || agent.name === meta.mainAgentName,
  )
}

/** User-created agents shown in squad / orchestration pickers. */
export function isOperativeUserAgent(agent: {
  name?: string
  role?: string
  config?: unknown
  source?: string
  node_id?: string | null
  hidden?: number | boolean | null
}): boolean {
  if (agent.hidden) return false
  return !isRuntimeMainAnchorAgent(agent)
}

/** Agents that can receive commands (includes sub-agents under runtime Main anchors). */
export function isSelectableOperativeAgent(
  agent: {
    id?: number
    name?: string
    role?: string
    config?: unknown
    source?: string
    node_id?: string | null
    hidden?: number | boolean | null
    parent_id?: number | null
  },
  allAgents: Array<{ id: number; parent_id?: number | null; name?: string; role?: string; config?: unknown }>,
): boolean {
  if (isHumanWatchAgent(agent)) return false
  if (!isOperativeUserAgent(agent)) return false
  if (!agent.parent_id) return true
  const parent = allAgents.find((item) => item.id === agent.parent_id)
  return Boolean(parent && isRuntimeMainAnchorAgent(parent))
}

export function getFrameworkSectionLabel(frameworkKey: string): string {
  if (frameworkKey === '__disk_imports__') return 'disk imports'
  const meta = getMainAgentRuntimeMeta(frameworkKey as MainAgentRuntimeId)
  if (meta) return meta.label.toUpperCase()
  const lower = frameworkKey.toLowerCase()
  if (lower.includes('claude')) return 'CLAUDE'
  if (lower.includes('codex')) return 'CODEX'
  if (lower.includes('cursor')) return 'CURSOR'
  if (lower.includes('opencode')) return 'OPENCODE'
  if (lower.includes('openclaw') || lower === 'gateway') return 'OPENCLAW'
  if (lower.includes('hermes')) return 'HERMES'
  return frameworkKey.toUpperCase()
}

/** Strip provider prefix from model ID: "anthropic/claude-opus-4-5" → "claude-opus-4-5" */
export function formatModelName(config: any): string | null {
  const raw = config?.model?.primary
  const primary = typeof raw === 'string' ? raw : raw?.primary
  if (!primary || typeof primary !== 'string') return null
  const parts = primary.split('/')
  return parts[parts.length - 1]
}

export interface TaskStats {
  total: number
  assigned: number
  in_progress: number
  quality_review: number
  done: number
  completed: number
}

export interface TaskStatPart {
  label: string
  count: number
  color?: string
}

/** Build inline task stat parts from agent taskStats, omitting zero counts. */
export function buildTaskStatParts(stats: TaskStats | undefined | null): TaskStatPart[] | null {
  if (!stats) return null
  const parts: TaskStatPart[] = []
  if (stats.assigned) parts.push({ label: 'assigned', count: stats.assigned })
  if (stats.in_progress) parts.push({ label: 'active', count: stats.in_progress, color: 'text-amber-300' })
  if (stats.quality_review) parts.push({ label: 'review', count: stats.quality_review, color: 'text-violet-300' })
  if (stats.done) parts.push({ label: 'done', count: stats.done, color: 'text-emerald-300' })
  return parts.length > 0 ? parts : null
}

/** Extract WebSocket host from connection URL for tooltip display. */
export function extractWsHost(url: string | undefined): string {
  if (!url) return '—'
  try {
    return new URL(url.replace(/^ws/, 'http')).host
  } catch {
    return '—'
  }
}
