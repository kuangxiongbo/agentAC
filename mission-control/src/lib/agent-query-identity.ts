import type Database from 'better-sqlite3'

export interface AgentQueryIdentity {
  id: number
  name: string
  role: string
  status: string
  sessionKey: string | null
  aliases: string[]
  clientId: string | null
  localAgentId: number | null
  syncIndexId: number | null
  source: 'agent' | 'bridge_index'
  record: Record<string, unknown>
}

export function uniqueAgentAliases(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))]
}

export function sqlPlaceholders(values: unknown[]) {
  return values.map(() => '?').join(', ')
}

export function resolveAgentQueryIdentity(
  db: Database.Database,
  agentId: string,
  workspaceId: number,
): AgentQueryIdentity | null {
  const numericId = Number(agentId)
  const edge = db.prepare(`
    SELECT sai.*
    FROM sync_agent_index sai
    JOIN sync_clients sc ON sc.client_id = sai.client_id
    WHERE sc.workspace_id = ?
      AND (sai.id = ? OR sai.remote_name = ? OR sai.original_name = ? COLLATE NOCASE)
    ORDER BY CASE WHEN sai.id = ? THEN 0 WHEN sai.remote_name = ? THEN 1 ELSE 2 END
    LIMIT 1
  `).get(
    workspaceId,
    Number.isInteger(numericId) ? numericId : -1,
    agentId,
    agentId,
    Number.isInteger(numericId) ? numericId : -1,
    agentId,
  ) as any
  if (edge) {
    return {
      id: edge.id,
      name: edge.remote_name,
      role: edge.role,
      status: edge.status,
      sessionKey: edge.session_key || null,
      aliases: uniqueAgentAliases([edge.remote_name, edge.original_name, edge.session_key]),
      clientId: edge.client_id,
      localAgentId: edge.local_agent_id,
      syncIndexId: edge.id,
      source: 'bridge_index',
      record: edge,
    }
  }

  const local = db.prepare(`
    SELECT * FROM agents
    WHERE workspace_id = ? AND (id = ? OR name = ?)
    LIMIT 1
  `).get(workspaceId, Number.isInteger(numericId) ? numericId : -1, agentId) as any
  if (!local) return null
  let config: Record<string, unknown> = {}
  try { config = JSON.parse(local.config || '{}') } catch {}
  const localAgentId = Number(config.local_agent_id)
  const clientId = String(local.node_id || config.bridge_client_id || config.sync_client_id || '').trim() || null
  if (clientId && Number.isFinite(localAgentId)) {
    const linkedEdge = db.prepare(`
      SELECT sai.*
      FROM sync_agent_index sai
      JOIN sync_clients sc ON sc.client_id = sai.client_id
      WHERE sc.workspace_id = ?
        AND sai.client_id = ?
        AND sai.local_agent_id = ?
      LIMIT 1
    `).get(workspaceId, clientId, localAgentId) as any
    if (linkedEdge) {
      return {
        id: linkedEdge.id,
        name: linkedEdge.remote_name,
        role: linkedEdge.role,
        status: linkedEdge.status,
        sessionKey: linkedEdge.session_key || local.session_key || null,
        aliases: uniqueAgentAliases([
          linkedEdge.remote_name,
          linkedEdge.original_name,
          linkedEdge.session_key,
          local.name,
          config.original_name as string,
          local.session_key,
        ]),
        clientId: linkedEdge.client_id,
        localAgentId: linkedEdge.local_agent_id,
        syncIndexId: linkedEdge.id,
        source: 'bridge_index',
        record: linkedEdge,
      }
    }
  }
  return {
    id: local.id,
    name: local.name,
    role: local.role,
    status: local.status,
    sessionKey: local.session_key || null,
    aliases: uniqueAgentAliases([local.name, config.original_name as string, local.session_key]),
    clientId,
    localAgentId: Number.isFinite(localAgentId) ? localAgentId : null,
    syncIndexId: null,
    source: 'agent',
    record: local,
  }
}
