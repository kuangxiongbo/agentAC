import { getDatabase } from './db'
import { eventBus } from './event-bus'
import { type SessionRealtimePayload } from './session-realtime-events'
import { listSyncClients, SYNC_CLIENT_STALE_SECONDS } from './sync-clients'

export interface SyncedSessionInput {
  clientId: string
  clientName: string
  sessionId: string
  sessionKey?: string | null
  sessionKind: 'claude-code' | 'codex-cli' | 'hermes' | 'gateway'
  runtimeGroup?: string | null
  agent?: string | null
  model?: string | null
  tokens?: string | null
  age?: string | null
  active?: boolean
  startTime?: number | null
  lastActivity?: number | null
  workingDir?: string | null
  lastUserPrompt?: string | null
}

export function replaceSyncedSessions(clientId: string, clientName: string, sessions: SyncedSessionInput[]) {
  const db = getDatabase()
  const now = Math.floor(Date.now() / 1000)

  const insert = db.prepare(`
    INSERT INTO sync_sessions (
      client_id, client_name, session_id, session_key, session_kind, runtime_group, agent, model, tokens, age,
      active, start_time, last_activity, working_dir, last_user_prompt, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(client_id, session_kind, session_id) DO UPDATE SET
      client_name = excluded.client_name,
      session_key = excluded.session_key,
      runtime_group = excluded.runtime_group,
      agent = excluded.agent,
      model = excluded.model,
      tokens = excluded.tokens,
      age = excluded.age,
      active = excluded.active,
      start_time = excluded.start_time,
      last_activity = excluded.last_activity,
      working_dir = excluded.working_dir,
      last_user_prompt = excluded.last_user_prompt,
      updated_at = excluded.updated_at
  `)

  const deleteMissing = db.prepare(`
    DELETE FROM sync_sessions
    WHERE client_id = ?
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(?)
        WHERE json_extract(json_each.value, '$.session_kind') = sync_sessions.session_kind
          AND json_extract(json_each.value, '$.session_id') = sync_sessions.session_id
      )
  `)

  const payload = JSON.stringify(
    sessions.map((session) => ({
      session_id: session.sessionId,
      session_kind: session.sessionKind,
    }))
  )

  db.transaction(() => {
    for (const session of sessions) {
      insert.run(
        clientId,
        clientName,
        session.sessionId,
        session.sessionKey || null,
        session.sessionKind,
        session.runtimeGroup || null,
        session.agent || null,
        session.model || null,
        session.tokens || null,
        session.age || null,
        session.active ? 1 : 0,
        session.startTime || null,
        session.lastActivity || null,
        session.workingDir || null,
        session.lastUserPrompt || null,
        now,
        now,
      )
    }

    deleteMissing.run(clientId, payload)
  })()

  eventBus.broadcast('session.list.updated', {
    source: 'synced',
    reason: 'sync_sessions_updated',
    sessionKey: clientId,
  } satisfies SessionRealtimePayload)
}

export function listSyncedSessions() {
  const db = getDatabase()
  const onlineClients = new Set(
    listSyncClients()
      .filter((client) => client.status === 'connected')
      .map((client) => client.client_id)
  )
  const staleCutoff = Math.floor(Date.now() / 1000) - SYNC_CLIENT_STALE_SECONDS

  const rows = db.prepare(`
    SELECT
      client_id,
      client_name,
      session_id,
      session_key,
      session_kind,
      runtime_group,
      agent,
      model,
      tokens,
      age,
      active,
      start_time,
      last_activity,
      working_dir,
      last_user_prompt
    FROM sync_sessions
    WHERE updated_at >= ?
    ORDER BY last_activity DESC, updated_at DESC
  `).all(staleCutoff) as Array<{
    client_id: string
    client_name: string
    session_id: string
    session_key: string | null
    session_kind: 'claude-code' | 'codex-cli' | 'hermes' | 'gateway'
    runtime_group: string | null
    agent: string | null
    model: string | null
    tokens: string | null
    age: string | null
    active: number | null
    start_time: number | null
    last_activity: number | null
    working_dir: string | null
    last_user_prompt: string | null
  }>

  return rows
    .filter((row) => onlineClients.has(row.client_id))
    .map((row) => ({
      id: `${row.client_id}:${row.session_kind}:${row.session_id}`,
      sessionId: row.session_id,
      key: row.session_key || row.session_id,
      agent: row.agent || row.client_name,
      kind: row.session_kind,
      age: row.age || '-',
      model: row.model && row.model !== 'unknown' ? row.model : null,
      tokens: row.tokens || '0/0',
      channel: 'client',
      flags: [],
      active: row.active === 1,
      startTime: row.start_time || 0,
      lastActivity: row.last_activity || 0,
      source: 'client' as const,
      nodeId: row.client_id,
      nodeLabel: row.client_name,
      workingDir: row.working_dir,
      lastUserPrompt: row.last_user_prompt,
      runtimeGroup: row.runtime_group || undefined,
    }))
}

export function getSyncedSession(clientId: string, sessionId: string) {
  const cid = String(clientId || '').trim()
  const sid = String(sessionId || '').trim()
  if (!cid || !sid) return null
  const db = getDatabase()
  const row = db.prepare(`
    SELECT
      client_id,
      client_name,
      session_id,
      session_key,
      session_kind,
      runtime_group,
      agent,
      model,
      tokens,
      age,
      active,
      start_time,
      last_activity,
      working_dir,
      last_user_prompt,
      updated_at
    FROM sync_sessions
    WHERE client_id = ? AND session_id = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(cid, sid) as {
    client_id: string
    client_name: string
    session_id: string
    session_key: string | null
    session_kind: 'claude-code' | 'codex-cli' | 'hermes' | 'gateway'
    runtime_group: string | null
    agent: string | null
    model: string | null
    tokens: string | null
    age: string | null
    active: number | null
    start_time: number | null
    last_activity: number | null
    working_dir: string | null
    last_user_prompt: string | null
    updated_at: number
  } | undefined
  return row ?? null
}
