import {
  getAgentBridgeSyncIndexId,
  getAgentClientId,
  getAgentLocalAgentId,
  readAgentConfigRecord,
} from '@/lib/agent-card-helpers'
import {
  getBridgeAgentIndexById,
  getBridgeAgentIndexByLocalId,
  getBridgeAgentIndexByRecipient,
} from '@/lib/sync-agent-index'

export interface AgentEdgeIdentity {
  client_id: string | null
  local_agent_id: number | null
  sync_index_id: number | null
  original_name: string | null
  remote_name: string | null
}

function fromIndexRow(row: {
  id: number
  client_id: string
  local_agent_id: number
  original_name: string
  remote_name: string
}): AgentEdgeIdentity {
  return {
    client_id: row.client_id,
    local_agent_id: row.local_agent_id,
    sync_index_id: row.id,
    original_name: row.original_name,
    remote_name: row.remote_name,
  }
}

/**
 * Resolve edge client_id + local_agent_id for squad / human-watch UI.
 */
export function resolveAgentEdgeIdentity(agent: {
  id?: number
  name?: string
  source?: string
  node_id?: string | null
  config?: unknown
  edge_local_agent_id?: number | null
  bridge_client_id?: string | null
}): AgentEdgeIdentity {
  const topLevelLocal =
    typeof agent.edge_local_agent_id === 'number' && Number.isFinite(agent.edge_local_agent_id)
      ? agent.edge_local_agent_id
      : null
  const topLevelClient =
    typeof agent.bridge_client_id === 'string' && agent.bridge_client_id.trim()
      ? agent.bridge_client_id.trim()
      : null

  if (typeof agent.id === 'number' && Number.isFinite(agent.id)) {
    const byId = getBridgeAgentIndexById(agent.id)
    if (byId) return fromIndexRow(byId)
  }

  const name = String(agent.name || '').trim()
  if (name) {
    const byRecipient = getBridgeAgentIndexByRecipient(name)
    if (byRecipient) return fromIndexRow(byRecipient)
  }

  const config = readAgentConfigRecord(agent.config)
  let clientId = topLevelClient || getAgentClientId(agent)
  if (!clientId) {
    const syncClient = String(config.sync_client_id || '').trim()
    if (syncClient) clientId = syncClient
  }

  let localAgentId = topLevelLocal ?? getAgentLocalAgentId(agent)
  const syncIndexId = getAgentBridgeSyncIndexId(agent)
  const originalName = String(config.original_name || '').trim()

  if (clientId && originalName) {
    const byOriginal = getBridgeAgentIndexByRecipient(originalName)
    if (byOriginal && byOriginal.client_id === clientId) return fromIndexRow(byOriginal)
  }

  if (clientId && localAgentId != null) {
    const byLocal = getBridgeAgentIndexByLocalId(clientId, localAgentId)
    if (byLocal) return fromIndexRow(byLocal)
  }

  return {
    client_id: clientId,
    local_agent_id: localAgentId,
    sync_index_id: syncIndexId,
    original_name: originalName || null,
    remote_name: name || null,
  }
}
