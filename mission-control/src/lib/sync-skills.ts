import { getDatabase } from './db'
import { listSyncClients } from './sync-clients'

export interface SyncedSkillRecord {
  name: string
  source: string
  path: string
  description?: string | null
  registry_slug?: string | null
  security_status?: string | null
}

export function replaceSyncedSkills(clientId: string, clientName: string, skills: SyncedSkillRecord[]) {
  const db = getDatabase()
  const now = Math.floor(Date.now() / 1000)
  const insert = db.prepare(`
    INSERT INTO sync_skills (
      client_id, client_name, name, source, path, description, registry_slug, security_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(client_id, source, name) DO UPDATE SET
      client_name = excluded.client_name,
      path = excluded.path,
      description = excluded.description,
      registry_slug = excluded.registry_slug,
      security_status = excluded.security_status,
      updated_at = excluded.updated_at
  `)

  const payload = JSON.stringify(
    skills.map((skill) => ({ source: skill.source, name: skill.name }))
  )
  const deleteMissing = db.prepare(`
    DELETE FROM sync_skills
    WHERE client_id = ?
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(?)
        WHERE json_extract(json_each.value, '$.source') = sync_skills.source
          AND json_extract(json_each.value, '$.name') = sync_skills.name
      )
  `)

  db.transaction(() => {
    for (const skill of skills) {
      insert.run(
        clientId,
        clientName,
        skill.name,
        skill.source,
        skill.path,
        skill.description || null,
        skill.registry_slug || null,
        skill.security_status || null,
        now,
        now,
      )
    }
    deleteMissing.run(clientId, payload)
  })()
}

export function listSyncedSkillsByClient() {
  const db = getDatabase()
  const onlineClients = new Set(
    listSyncClients()
      .filter((client) => client.status === 'connected')
      .map((client) => client.client_id)
  )

  const rows = db.prepare(`
    SELECT client_id, client_name, name, source, path, description, registry_slug, security_status
    FROM sync_skills
    ORDER BY client_name ASC, source ASC, name ASC
  `).all() as Array<{
    client_id: string
    client_name: string
    name: string
    source: string
    path: string
    description: string | null
    registry_slug: string | null
    security_status: string | null
  }>

  const clientMap = new Map<string, {
    client_id: string
    client_name: string
    total: number
    skills: Array<{
      id: string
      name: string
      source: string
      path: string
      description?: string
      registry_slug?: string | null
      security_status?: string | null
    }>
    groups: Array<{
      source: string
      path: string
      skills: Array<{
        id: string
        name: string
        source: string
        path: string
        description?: string
        registry_slug?: string | null
        security_status?: string | null
      }>
    }>
  }>()

  for (const row of rows) {
    if (!onlineClients.has(row.client_id)) continue
    if (!clientMap.has(row.client_id)) {
      clientMap.set(row.client_id, {
        client_id: row.client_id,
        client_name: row.client_name,
        total: 0,
        skills: [],
        groups: [],
      })
    }
    const client = clientMap.get(row.client_id)!
    const skill = {
      id: `${row.client_id}:${row.source}:${row.name}`,
      name: row.name,
      source: row.source,
      path: row.path,
      description: row.description || undefined,
      registry_slug: row.registry_slug,
      security_status: row.security_status,
    }
    client.skills.push(skill)
    client.total += 1
  }

  for (const client of clientMap.values()) {
    const groupMap = new Map<string, { source: string; path: string; skills: typeof client.skills }>()
    for (const skill of client.skills) {
      if (!groupMap.has(skill.source)) {
        groupMap.set(skill.source, { source: skill.source, path: skill.path, skills: [] })
      }
      groupMap.get(skill.source)!.skills.push(skill)
    }
    client.groups = Array.from(groupMap.values())
  }

  return Array.from(clientMap.values()).sort((a, b) => a.client_name.localeCompare(b.client_name))
}
