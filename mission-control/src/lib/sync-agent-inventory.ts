import { getDatabase } from './db'
import { eventBus } from './event-bus'

export interface SyncedAgentInventoryItem {
  local_agent_id?: number
  original_name: string
  status?: string
  role?: string
  framework?: string | null
}

export function parseAgentInventory(raw: unknown): SyncedAgentInventoryItem[] {
  if (!Array.isArray(raw)) return []
  const items: SyncedAgentInventoryItem[] = []
  for (const item of raw) {
    const originalName = typeof item?.original_name === 'string' ? item.original_name.trim() : ''
    if (!originalName) continue
    items.push({
      local_agent_id:
        typeof item?.local_agent_id === 'number' && Number.isFinite(item.local_agent_id)
          ? item.local_agent_id
          : undefined,
      original_name: originalName,
      status: typeof item?.status === 'string' ? item.status : undefined,
      role: typeof item?.role === 'string' ? item.role : undefined,
      framework:
        typeof item?.framework === 'string'
          ? item.framework
          : item?.framework === null
            ? null
            : undefined,
    })
  }
  return items
}

function slugifyAscii(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

function hashSuffix(value: string): string {
  let hash = 0
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }
  return hash.toString(36).slice(0, 8)
}

/** Mirrors mission-control-client gateway-sync registration names. */
export function buildRemoteAgentRegistrationName(clientName: string, agentName: string): string {
  const clientSlug = slugifyAscii(clientName) || 'edge'
  const agentSlug = slugifyAscii(agentName)
  if (agentSlug) return `${clientSlug}-${agentSlug}`.slice(0, 63)
  return `${clientSlug}-agent-${hashSuffix(agentName)}`.slice(0, 63)
}

export function buildInventoryMatchSets(clientName: string, inventory: SyncedAgentInventoryItem[]) {
  const localAgentIds = new Set(
    inventory
      .map((item) => item.local_agent_id)
      .filter((id): id is number => typeof id === 'number' && Number.isFinite(id)),
  )
  const originalNames = new Set(
    inventory.map((item) => item.original_name.trim().toLowerCase()).filter(Boolean),
  )
  const remoteNames = new Set(
    inventory.map((item) =>
      buildRemoteAgentRegistrationName(clientName, item.original_name).toLowerCase(),
    ),
  )
  return { localAgentIds, originalNames, remoteNames }
}

export function shouldRetainClientSyncedAgent(
  row: { name: string; config: string | null },
  matchSets: ReturnType<typeof buildInventoryMatchSets>,
): boolean {
  let config: Record<string, unknown> = {}
  if (row.config) {
    try {
      config = JSON.parse(row.config) as Record<string, unknown>
    } catch {
      config = {}
    }
  }

  const localAgentId = Number(config.local_agent_id)
  if (Number.isFinite(localAgentId) && matchSets.localAgentIds.has(localAgentId)) {
    return true
  }

  const originalName = String(config.original_name || '').trim().toLowerCase()
  if (originalName) return matchSets.originalNames.has(originalName)

  const remoteName = String(row.name || '').trim().toLowerCase()
  return matchSets.remoteNames.has(remoteName)
}

/**
 * Remove client-mirrored agents that are no longer present in the edge inventory (Plan A).
 * Only touches `source = 'client'` rows scoped to `node_id = clientId`.
 */
export function reconcileClientAgentInventory(
  workspaceId: number,
  clientId: string,
  clientName: string,
  inventory: SyncedAgentInventoryItem[],
): { removed: number } {
  const db = getDatabase()
  const matchSets = buildInventoryMatchSets(clientName, inventory)
  const rows = db
    .prepare(
      `
      SELECT id, name, config
      FROM agents
      WHERE workspace_id = ? AND source = 'client' AND node_id = ?
    `,
    )
    .all(workspaceId, clientId) as Array<{ id: number; name: string; config: string | null }>

  const toRemove = rows.filter((row) => !shouldRetainClientSyncedAgent(row, matchSets))
  if (toRemove.length === 0) return { removed: 0 }

  const deleteStmt = db.prepare('DELETE FROM agents WHERE id = ? AND workspace_id = ?')
  db.transaction(() => {
    for (const row of toRemove) {
      deleteStmt.run(row.id, workspaceId)
    }
  })()

  for (const row of toRemove) {
    eventBus.broadcast('agent.deleted', { id: row.id, name: row.name })
  }

  return { removed: toRemove.length }
}

export function cleanupDuplicateClientAgents(
  workspaceId: number,
  clientId: string,
): { removed: number } {
  const db = getDatabase()
  const rows = db.prepare(`
    SELECT id, name, created_at, updated_at, config
    FROM agents
    WHERE workspace_id = ? AND source = 'client' AND node_id = ?
    ORDER BY updated_at DESC, created_at DESC, id DESC
  `).all(workspaceId, clientId) as Array<{
    id: number
    name: string
    created_at: number | null
    updated_at: number | null
    config: string | null
  }>

  const seenByLocalId = new Set<string>()
  const seenByOriginalName = new Set<string>()
  const toRemove: Array<{ id: number; name: string }> = []

  for (const row of rows) {
    let config: Record<string, unknown> = {}
    if (row.config) {
      try {
        config = JSON.parse(row.config) as Record<string, unknown>
      } catch {
        config = {}
      }
    }

    const localAgentId = Number(config.local_agent_id)
    const originalName = String(config.original_name || '').trim().toLowerCase()

    if (Number.isFinite(localAgentId)) {
      const key = `${clientId}:${localAgentId}`
      if (seenByLocalId.has(key)) {
        toRemove.push({ id: row.id, name: row.name })
        continue
      }
      seenByLocalId.add(key)
    }

    if (originalName) {
      const key = `${clientId}:${originalName}`
      if (seenByOriginalName.has(key)) {
        toRemove.push({ id: row.id, name: row.name })
        continue
      }
      seenByOriginalName.add(key)
    }
  }

  if (toRemove.length === 0) return { removed: 0 }

  const deleteStmt = db.prepare('DELETE FROM agents WHERE id = ? AND workspace_id = ?')
  db.transaction(() => {
    for (const row of toRemove) {
      deleteStmt.run(row.id, workspaceId)
    }
  })()

  for (const row of toRemove) {
    eventBus.broadcast('agent.deleted', { id: row.id, name: row.name })
  }

  return { removed: toRemove.length }
}
