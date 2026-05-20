import { getDatabase } from './db'
import { eventBus } from './event-bus'

export interface BridgeAgentIndexInput {
  id: number
  name: string
  role: string
  status: string
  framework?: string | null
  parent_id?: number | null
}

export interface SyncAgentIndexRow {
  id: number
  client_id: string
  client_name: string
  local_agent_id: number
  original_name: string
  remote_name: string
  role: string
  status: string
  framework: string | null
  parent_local_id: number | null
  updated_at: number
}

function buildRemoteName(clientId: string, originalName: string): string {
  return `${clientId}-${originalName}`.slice(0, 120)
}

/** Replace edge agent index for a connected Bridge client (hybrid list cache). */
export function replaceBridgeAgentIndex(
  clientId: string,
  clientName: string,
  agents: BridgeAgentIndexInput[],
): { upserted: number; removed: number } {
  const db = getDatabase()
  const now = Math.floor(Date.now() / 1000)

  const insert = db.prepare(`
    INSERT INTO sync_agent_index (
      client_id, client_name, local_agent_id, original_name, remote_name,
      role, status, framework, parent_local_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(client_id, local_agent_id) DO UPDATE SET
      client_name = excluded.client_name,
      original_name = excluded.original_name,
      remote_name = excluded.remote_name,
      role = excluded.role,
      status = excluded.status,
      framework = excluded.framework,
      parent_local_id = excluded.parent_local_id,
      updated_at = excluded.updated_at
  `)

  const payload = JSON.stringify(
    agents.map((agent) => ({
      local_agent_id: agent.id,
    })),
  )

  let upserted = 0
  db.transaction(() => {
    for (const agent of agents) {
      const originalName = String(agent.name || '').trim()
      if (!originalName || !Number.isFinite(agent.id)) continue
      insert.run(
        clientId,
        clientName,
        agent.id,
        originalName,
        buildRemoteName(clientId, originalName),
        agent.role || 'agent',
        agent.status || 'idle',
        agent.framework || null,
        agent.parent_id ?? null,
        now,
      )
      upserted++
    }

    db.prepare(`
      DELETE FROM sync_agent_index
      WHERE client_id = ?
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(?)
          WHERE json_extract(json_each.value, '$.local_agent_id') = sync_agent_index.local_agent_id
        )
    `).run(clientId, payload)
  })()

  eventBus.broadcast('agent.synced', { clientId, source: 'bridge_index', count: upserted })

  return { upserted, removed: 0 }
}

export function listBridgeAgentIndex(clientId?: string): SyncAgentIndexRow[] {
  const db = getDatabase()
  if (clientId) {
    return db
      .prepare(
        `
        SELECT *
        FROM sync_agent_index
        WHERE client_id = ?
        ORDER BY original_name COLLATE NOCASE ASC
      `,
      )
      .all(clientId) as SyncAgentIndexRow[]
  }
  return db
    .prepare(
      `
      SELECT *
      FROM sync_agent_index
      ORDER BY client_name COLLATE NOCASE ASC, original_name COLLATE NOCASE ASC
    `,
    )
    .all() as SyncAgentIndexRow[]
}

export function getBridgeAgentIndexByRemoteName(
  clientId: string,
  remoteName: string,
): SyncAgentIndexRow | undefined {
  const db = getDatabase()
  return db
    .prepare(`SELECT * FROM sync_agent_index WHERE client_id = ? AND remote_name = ? LIMIT 1`)
    .get(clientId, remoteName) as SyncAgentIndexRow | undefined
}

export function getBridgeAgentIndexByLocalId(
  clientId: string,
  localAgentId: number,
): SyncAgentIndexRow | undefined {
  const db = getDatabase()
  return db
    .prepare(`SELECT * FROM sync_agent_index WHERE client_id = ? AND local_agent_id = ? LIMIT 1`)
    .get(clientId, localAgentId) as SyncAgentIndexRow | undefined
}

export function mapEdgeAgentsToBindingRows(
  clientId: string,
  edgeAgents: Array<{
    id: number
    name: string
    role: string
    session_key: string | null
    framework: string | null
    workspace_path: string | null
    status: string
  }>,
) {
  return edgeAgents.map((agent) => {
    const indexRow = getBridgeAgentIndexByLocalId(clientId, agent.id)
    return {
      id: indexRow?.id ?? agent.id,
      name: indexRow?.remote_name ?? `${clientId}-${agent.name}`,
      role: agent.role,
      session_key: agent.session_key,
      framework: agent.framework,
      workspace_path: agent.workspace_path,
      status: agent.status,
    }
  })
}

export function getBridgeAgentIndexById(indexId: number): SyncAgentIndexRow | undefined {
  const db = getDatabase()
  return db
    .prepare(`SELECT * FROM sync_agent_index WHERE id = ?`)
    .get(indexId) as SyncAgentIndexRow | undefined
}

export function clientAgentInventoryKey(
  nodeId: string | null | undefined,
  config: unknown,
): string | null {
  if (!nodeId) return null
  let parsed: Record<string, unknown> = {}
  if (typeof config === 'string') {
    try {
      parsed = JSON.parse(config) as Record<string, unknown>
    } catch {
      parsed = {}
    }
  } else if (config && typeof config === 'object' && !Array.isArray(config)) {
    parsed = config as Record<string, unknown>
  }
  const originalName = String(parsed.original_name || '').trim()
  if (!originalName) return null
  return `${nodeId}:${originalName.toLowerCase()}`
}

export function mergeDbAgentsWithBridgeIndex<T extends { source?: string; node_id?: string | null; config?: unknown }>(
  dbAgents: T[],
  indexRows: SyncAgentIndexRow[],
  bridgeOnline: (clientId: string) => boolean,
): Array<T | ReturnType<typeof bridgeIndexRowToAgentListItem>> {
  const indexByKey = new Map<string, SyncAgentIndexRow>(
    indexRows.map((row) => [`${row.client_id}:${row.original_name.toLowerCase()}`, row]),
  )

  const clientMirrorKeys = new Set<string>()
  for (const agent of dbAgents) {
    const key = clientAgentInventoryKey(agent.node_id, agent.config)
    if (key) clientMirrorKeys.add(key)
  }

  // Bridge 在线：同 key 的 HTTP client 镜像让位给 bridge_index（以边缘实时索引为准）
  const filteredDbAgents = dbAgents.filter((agent) => {
    if (agent.source !== 'client') return true
    const key = clientAgentInventoryKey(agent.node_id, agent.config)
    if (!key || !bridgeOnline(agent.node_id || '')) return true
    return !indexByKey.has(key)
  })

  const merged: Array<T | ReturnType<typeof bridgeIndexRowToAgentListItem>> = [...filteredDbAgents]
  for (const row of indexRows) {
    const key = `${row.client_id}:${row.original_name.toLowerCase()}`
    const online = bridgeOnline(row.client_id)
    if (online) {
      merged.push(bridgeIndexRowToAgentListItem(row, true))
      continue
    }
    // Bridge 离线：保留 HTTP 镜像；无镜像时才展示上次索引缓存
    if (!clientMirrorKeys.has(key)) {
      merged.push(bridgeIndexRowToAgentListItem(row, false))
    }
  }
  return merged
}

export function bridgeIndexRowToAgentListItem(row: SyncAgentIndexRow, bridgeOnline = false) {
  return {
    id: row.id,
    name: row.remote_name,
    role: row.role,
    status: row.status,
    framework: row.framework,
    source: 'bridge_index' as const,
    node_id: row.client_id,
    hidden: 0,
    parent_id: null,
    workspace_id: 1,
    last_seen: row.updated_at,
    updated_at: row.updated_at,
    created_at: row.updated_at,
    config: {
      original_name: row.original_name,
      local_agent_id: row.local_agent_id,
      bridge_client_id: row.client_id,
      node_label: row.client_name,
    },
    bridge_online: bridgeOnline,
    remote: true,
    detail_cached: false,
  }
}
