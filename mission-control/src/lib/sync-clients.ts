import { getDatabase } from './db'

export const SYNC_CLIENT_STALE_SECONDS = 3 * 60

export interface SyncClientRecord {
  client_id: string
  client_name: string
  agent_count: number
  last_seen: number
  last_sync_source: string | null
  status: 'connected' | 'disconnected'
}

export interface SyncClientIdentity {
  clientId: string
  clientName: string
}

export function readSyncClientIdentity(headers: Pick<Headers, 'get'>): SyncClientIdentity | null {
  const clientId = (headers.get('x-sync-client-id') || '').trim()
  const clientName = (headers.get('x-sync-client-name') || '').trim()
  if (!clientId || !clientName) return null
  return { clientId, clientName }
}

export function upsertSyncClientHeartbeat(input: {
  clientId: string
  clientName: string
  source: string
  agentCount?: number
}) {
  const db = getDatabase()
  const now = Math.floor(Date.now() / 1000)
  db.prepare('DELETE FROM sync_clients WHERE client_name = ? AND client_id != ?').run(input.clientName, input.clientId)
  db.prepare(`
    INSERT INTO sync_clients (client_id, client_name, agent_count, last_seen, last_sync_source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(client_id) DO UPDATE SET
      client_name = excluded.client_name,
      agent_count = excluded.agent_count,
      last_seen = excluded.last_seen,
      last_sync_source = excluded.last_sync_source,
      updated_at = excluded.updated_at
  `).run(
    input.clientId,
    input.clientName,
    Math.max(0, Number(input.agentCount || 0)),
    now,
    input.source,
    now,
    now,
  )

  return {
    client_id: input.clientId,
    client_name: input.clientName,
    agent_count: Math.max(0, Number(input.agentCount || 0)),
    last_seen: now,
    last_sync_source: input.source,
    status: 'connected' as const,
  }
}

export function listSyncClients(): SyncClientRecord[] {
  const db = getDatabase()
  const now = Math.floor(Date.now() / 1000)
  const rows = db.prepare(`
    SELECT client_id, client_name, agent_count, last_seen, last_sync_source
    FROM sync_clients
    ORDER BY last_seen DESC, client_name ASC
  `).all() as Array<{
    client_id: string
    client_name: string
    agent_count: number | null
    last_seen: number | null
    last_sync_source: string | null
  }>

  return rows.map((row) => {
    const lastSeen = Number(row.last_seen || 0)
    return {
      client_id: row.client_id,
      client_name: row.client_name,
      agent_count: Number(row.agent_count || 0),
      last_seen: lastSeen,
      last_sync_source: row.last_sync_source,
      status: now - lastSeen <= SYNC_CLIENT_STALE_SECONDS ? 'connected' : 'disconnected',
    }
  })
}
