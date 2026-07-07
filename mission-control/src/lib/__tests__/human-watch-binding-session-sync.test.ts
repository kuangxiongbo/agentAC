import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'

describe('syncHumanWatchBindingSessionIds', () => {
  let db: Database.Database

  beforeEach(() => {
    vi.resetModules()
    db = new Database(':memory:')
    runMigrations(db)
    vi.doMock('@/lib/db', () => ({
      getDatabase: () => db,
    }))
  })

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })

  it('updates worker_session_id and worker_session_kind from sync_agent_index session_key', async () => {
    const { replaceBridgeAgentIndex } = await import('@/lib/sync-agent-index')
    const { syncHumanWatchBindingSessionIds } = await import('@/lib/human-watch-bindings')

    replaceBridgeAgentIndex('edge-a', 'Mac', [
      {
        id: 7,
        name: 'worker',
        role: 'coder',
        status: 'idle',
        framework: 'codex-cli',
        session_key: 'codex-session-uuid',
      },
    ])

    db.prepare(
      `INSERT INTO human_watch_bindings (
        workspace_id, client_id, worker_local_agent_id, steward_local_agent_id,
        worker_session_id, enabled, mode, created_at, updated_at
      ) VALUES (1, 'edge-a', 7, 3, 'stale-id', 1, 'auto_send', 1, 1)`,
    ).run()

    const updated = syncHumanWatchBindingSessionIds('edge-a', 1, db)
    expect(updated).toBe(1)

    const row = db
      .prepare(`SELECT worker_session_id, worker_session_kind FROM human_watch_bindings WHERE id = 1`)
      .get() as { worker_session_id: string; worker_session_kind: string | null }
    expect(row.worker_session_id).toBe('codex-session-uuid')
    expect(row.worker_session_kind).toBe('codex-cli')
  })
})
