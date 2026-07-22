import type Database from 'better-sqlite3'
import type { BridgeAgentIndexInput } from './sync-agent-index'

export function resolveBridgeClientWorkspaceId(db: Database.Database, clientId: string): number {
  const row = db.prepare(`SELECT workspace_id FROM sync_clients WHERE client_id = ? LIMIT 1`)
    .get(clientId) as { workspace_id?: number | null } | undefined
  const workspaceId = Number(row?.workspace_id || 1)
  return Number.isInteger(workspaceId) && workspaceId > 0 ? workspaceId : 1
}

export function upsertBridgeAgentInventory(
  db: Database.Database,
  input: {
    clientId: string
    clientLabel: string
    workspaceId: number
    agents: BridgeAgentIndexInput[]
    now?: number
  },
) {
  const now = input.now ?? Math.floor(Date.now() / 1000)
  const upsert = db.prepare(`
    INSERT INTO agents (name, role, status, source, last_seen, updated_at, workspace_id, node_id, framework, parent_id, config)
    VALUES (?, ?, ?, 'bridge', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name, workspace_id) DO UPDATE SET
      role = excluded.role,
      status = excluded.status,
      last_seen = excluded.last_seen,
      updated_at = excluded.updated_at,
      node_id = excluded.node_id,
      framework = excluded.framework,
      parent_id = excluded.parent_id,
      config = excluded.config
  `)

  db.transaction(() => {
    for (const agent of input.agents) {
      const configJson = JSON.stringify({
        node_label: input.clientLabel || input.clientId,
        bridge_client_id: input.clientId,
      })
      upsert.run(
        `${input.clientId}-${agent.name}`,
        agent.role || 'remote agent',
        agent.status || 'idle',
        now,
        now,
        input.workspaceId,
        input.clientId,
        agent.framework || 'openclaw',
        agent.parent_id ?? null,
        configJson,
      )
    }
  })()
}
