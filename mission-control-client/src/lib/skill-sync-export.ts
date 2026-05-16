import { getDatabase } from './db'

export interface SyncableSkillRecord {
  name: string
  source: string
  path: string
  description?: string | null
  registry_slug?: string | null
  security_status?: string | null
}

export function getSyncableSkills(): SyncableSkillRecord[] {
  try {
    const db = getDatabase()
    const rows = db.prepare(`
      SELECT name, source, path, description, registry_slug, security_status
      FROM skills
      ORDER BY source ASC, name ASC
    `).all() as SyncableSkillRecord[]
    return rows
  } catch {
    return []
  }
}
