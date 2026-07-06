import { getAgentDisplayName } from './agent-card-helpers'
import { getDatabase } from './db'
import { eventBus } from './event-bus'

export interface BridgeAgentIndexInput {
  id: number
  name: string
  role: string
  status: string
  framework?: string | null
  parent_id?: number | null
  session_key?: string | null
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
  session_key: string | null
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
      role, status, framework, parent_local_id, session_key, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(client_id, local_agent_id) DO UPDATE SET
      client_name = excluded.client_name,
      original_name = excluded.original_name,
      remote_name = excluded.remote_name,
      role = excluded.role,
      status = excluded.status,
      framework = COALESCE(excluded.framework, sync_agent_index.framework),
      parent_local_id = COALESCE(excluded.parent_local_id, sync_agent_index.parent_local_id),
      session_key = COALESCE(excluded.session_key, sync_agent_index.session_key),
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
        agent.session_key?.trim() || null,
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

  void import('./human-watch-bindings')
    .then((mod) => mod.syncHumanWatchBindingSessionIds(clientId))
    .then((synced) => {
      if (synced > 0) {
        eventBus.broadcast('human_watch.bindings_synced', { clientId, count: synced })
      }
    })
    .catch(() => {
      /* ignore */
    })

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

/** Resolve orchestration/command recipient to a Bridge index row (remote_name or original_name). */
export function getBridgeAgentIndexByRecipient(recipient: string): SyncAgentIndexRow | undefined {
  const trimmed = String(recipient || '').trim()
  if (!trimmed) return undefined
  const db = getDatabase()
  const byRemote = db
    .prepare(`SELECT * FROM sync_agent_index WHERE remote_name = ? LIMIT 1`)
    .get(trimmed) as SyncAgentIndexRow | undefined
  if (byRemote) return byRemote
  return db
    .prepare(
      `SELECT * FROM sync_agent_index WHERE original_name = ? COLLATE NOCASE ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(trimmed) as SyncAgentIndexRow | undefined
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

export function deleteBridgeAgentIndexByLocalId(
  clientId: string,
  localAgentId: number,
): boolean {
  const db = getDatabase()
  const result = db
    .prepare(
      `DELETE FROM sync_agent_index WHERE client_id = ? AND local_agent_id = ?`,
    )
    .run(clientId, localAgentId)
  return result.changes > 0
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

function clientAgentLocalIdKey(
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
  const localAgentId = Number(parsed.local_agent_id)
  if (!Number.isFinite(localAgentId)) return null
  return `${nodeId}:${localAgentId}`
}

export function mergeDbAgentsWithBridgeIndex<T extends { source?: string; node_id?: string | null; config?: unknown }>(
  dbAgents: T[],
  indexRows: SyncAgentIndexRow[],
  bridgeOnline: (clientId: string) => boolean,
): Array<T | ReturnType<typeof bridgeIndexRowToAgentListItem>> {
  const indexByKey = new Map<string, SyncAgentIndexRow>(
    indexRows.map((row) => [`${row.client_id}:${row.original_name.toLowerCase()}`, row]),
  )
  const indexByLocalId = new Map<string, SyncAgentIndexRow>(
    indexRows.map((row) => [`${row.client_id}:${row.local_agent_id}`, row]),
  )

  const clientMirrorKeys = new Set<string>()
  const clientMirrorLocalIdKeys = new Set<string>()
  for (const agent of dbAgents) {
    const key = clientAgentInventoryKey(agent.node_id, agent.config)
    if (key) clientMirrorKeys.add(key)
    const localIdKey = clientAgentLocalIdKey(agent.node_id, agent.config)
    if (localIdKey) clientMirrorLocalIdKeys.add(localIdKey)
  }

  // Bridge 在线：同 key 的 HTTP client 镜像让位给 bridge_index（以边缘实时索引为准）
  const filteredDbAgents = dbAgents.filter((agent) => {
    if (agent.source !== 'client') return true
    const localIdKey = clientAgentLocalIdKey(agent.node_id, agent.config)
    if (localIdKey && bridgeOnline(agent.node_id || '') && indexByLocalId.has(localIdKey)) {
      return false
    }
    const key = clientAgentInventoryKey(agent.node_id, agent.config)
    if (!bridgeOnline(agent.node_id || '')) return true
    if (!key) {
      let parsed: Record<string, unknown> = {}
      if (typeof agent.config === 'string') {
        try {
          parsed = JSON.parse(agent.config) as Record<string, unknown>
        } catch {
          parsed = {}
        }
      } else if (agent.config && typeof agent.config === 'object' && !Array.isArray(agent.config)) {
        parsed = agent.config as Record<string, unknown>
      }
      const originalName = String(parsed.original_name || '').trim().toLowerCase()
      const clientId = String(agent.node_id || '').trim()
      if (clientId && originalName && indexByKey.has(`${clientId}:${originalName}`)) {
        return false
      }
      return true
    }
    return !indexByKey.has(key)
  })

  const merged: Array<T | ReturnType<typeof bridgeIndexRowToAgentListItem>> = [...filteredDbAgents]
  for (const row of indexRows) {
    const key = `${row.client_id}:${row.original_name.toLowerCase()}`
    const localIdKey = `${row.client_id}:${row.local_agent_id}`
    const online = bridgeOnline(row.client_id)
    if (online) {
      merged.push(bridgeIndexRowToAgentListItem(row, true))
      continue
    }
    // Bridge 离线：保留 HTTP 镜像；无镜像时才展示上次索引缓存
    if (!clientMirrorKeys.has(key) && !clientMirrorLocalIdKeys.has(localIdKey)) {
      merged.push(bridgeIndexRowToAgentListItem(row, false))
    }
  }
  return merged
}

/** Keep bridge index ids on agent.config after live edge detail fetch. */
export function mergeBridgeIndexIntoConfig(
  config: Record<string, unknown>,
  row: Pick<
    SyncAgentIndexRow,
    'local_agent_id' | 'client_id' | 'client_name' | 'original_name'
  >,
): Record<string, unknown> {
  return {
    ...config,
    local_agent_id: row.local_agent_id,
    bridge_client_id: row.client_id,
    original_name: row.original_name,
    node_label: row.client_name,
  }
}

export function bridgeIndexRowToAgentListItem(row: SyncAgentIndexRow, bridgeOnline = false) {
  const config = mergeBridgeIndexIntoConfig({}, row)
  const display_name = getAgentDisplayName({
    name: row.remote_name,
    config,
    source: 'bridge_index',
    node_id: row.client_id,
  })
  return {
    id: row.id,
    name: row.remote_name,
    display_name,
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
    session_key: row.session_key || undefined,
    edge_local_agent_id: row.local_agent_id,
    bridge_client_id: row.client_id,
    config,
    bridge_online: bridgeOnline,
    remote: true,
    detail_cached: false,
  }
}
