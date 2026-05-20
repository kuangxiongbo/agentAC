import type Database from 'better-sqlite3'

export type AgentSessionBindingRow = {
  id: number
  name: string
  role: string
  session_key: string | null
  framework: string | null
  workspace_path: string | null
  status: string
}

/** Find agents whose session_key or primary_session_key matches the CLI session id/key. */
export function findAgentsBoundToSession(
  db: Database.Database,
  workspaceId: number,
  sessionId: string,
  sessionKey?: string,
): AgentSessionBindingRow[] {
  const id = sessionId.trim()
  const key = sessionKey?.trim() || ''
  if (!id && !key) return []

  const clauses: string[] = []
  const params: Array<string | number> = [workspaceId]

  if (id) {
    clauses.push(`TRIM(COALESCE(session_key, '')) = ?`)
    params.push(id)
    clauses.push(`TRIM(COALESCE(json_extract(config, '$.primary_session_key'), '')) = ?`)
    params.push(id)
  }

  if (key) {
    clauses.push(`TRIM(COALESCE(session_key, '')) = ?`)
    params.push(key)
    clauses.push(`TRIM(COALESCE(json_extract(config, '$.primary_session_key'), '')) = ?`)
    params.push(key)
  }

  if (clauses.length === 0) return []

  return db
    .prepare(
      `SELECT id, name, role, session_key, framework, workspace_path, status
       FROM agents
       WHERE workspace_id = ?
         AND (${clauses.join(' OR ')})`,
    )
    .all(...params) as AgentSessionBindingRow[]
}
