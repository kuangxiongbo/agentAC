import { getDatabase } from './db'
import { listSyncClients } from './sync-clients'

export interface SyncedMemoryAgentRecord {
  name: string
  dbSize: number
  totalChunks: number
  totalFiles: number
  files: Array<{ path: string; chunks: number; textSize: number }>
}

export function replaceSyncedMemoryAgents(clientId: string, clientName: string, agents: SyncedMemoryAgentRecord[]) {
  const db = getDatabase()
  const now = Math.floor(Date.now() / 1000)
  const insert = db.prepare(`
    INSERT INTO sync_memory_agents (
      client_id, client_name, agent_name, db_size, total_chunks, total_files, files_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(client_id, agent_name) DO UPDATE SET
      client_name = excluded.client_name,
      db_size = excluded.db_size,
      total_chunks = excluded.total_chunks,
      total_files = excluded.total_files,
      files_json = excluded.files_json,
      updated_at = excluded.updated_at
  `)
  const payload = JSON.stringify(agents.map((agent) => ({ agent_name: agent.name })))
  const deleteMissing = db.prepare(`
    DELETE FROM sync_memory_agents
    WHERE client_id = ?
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(?)
        WHERE json_extract(json_each.value, '$.agent_name') = sync_memory_agents.agent_name
      )
  `)

  db.transaction(() => {
    for (const agent of agents) {
      insert.run(
        clientId,
        clientName,
        agent.name,
        agent.dbSize,
        agent.totalChunks,
        agent.totalFiles,
        JSON.stringify(agent.files || []),
        now,
        now,
      )
    }
    deleteMissing.run(clientId, payload)
  })()
}

export function listSyncedMemoryByClient() {
  const db = getDatabase()
  const onlineClients = new Set(
    listSyncClients()
      .filter((client) => client.status === 'connected')
      .map((client) => client.client_id)
  )

  const rows = db.prepare(`
    SELECT client_id, client_name, agent_name, db_size, total_chunks, total_files, files_json
    FROM sync_memory_agents
    ORDER BY client_name ASC, agent_name ASC
  `).all() as Array<{
    client_id: string
    client_name: string
    agent_name: string
    db_size: number | null
    total_chunks: number | null
    total_files: number | null
    files_json: string | null
  }>

  const clientMap = new Map<string, {
    client_id: string
    client_name: string
    totalAgents: number
    totalFiles: number
    totalChunks: number
    totalSize: number
    agents: SyncedMemoryAgentRecord[]
  }>()

  for (const row of rows) {
    if (!onlineClients.has(row.client_id)) continue
    if (!clientMap.has(row.client_id)) {
      clientMap.set(row.client_id, {
        client_id: row.client_id,
        client_name: row.client_name,
        totalAgents: 0,
        totalFiles: 0,
        totalChunks: 0,
        totalSize: 0,
        agents: [],
      })
    }
    const client = clientMap.get(row.client_id)!
    const files = (() => {
      try {
        const parsed = JSON.parse(row.files_json || '[]')
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    })()
    const agent: SyncedMemoryAgentRecord = {
      name: row.agent_name,
      dbSize: Number(row.db_size || 0),
      totalChunks: Number(row.total_chunks || 0),
      totalFiles: Number(row.total_files || 0),
      files,
    }
    client.agents.push(agent)
    client.totalAgents += 1
    client.totalFiles += agent.totalFiles
    client.totalChunks += agent.totalChunks
    client.totalSize += agent.dbSize
  }

  return Array.from(clientMap.values()).sort((a, b) => a.client_name.localeCompare(b.client_name))
}
