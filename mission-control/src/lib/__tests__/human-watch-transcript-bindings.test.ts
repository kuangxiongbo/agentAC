import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'
import { replaceBridgeAgentIndex } from '@/lib/sync-agent-index'

describe('listEnabledBindingsForTranscriptUpdate', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
    db.prepare(
      `INSERT INTO human_watch_bindings (
        workspace_id, tenant_id, client_id,
        worker_local_agent_id, worker_session_id, steward_local_agent_id,
        enabled, mode, created_at, updated_at
      ) VALUES (1, 1, 'mac-1', 10, 'stale-session-id', 9, 1, 'auto_send', 1, 1)`,
    ).run()
    replaceBridgeAgentIndex('mac-1', 'Mac', [
      {
        id: 10,
        name: 'worker',
        role: 'agent',
        status: 'idle',
        framework: 'codex-cli',
        session_key: 'real-codex-session',
      },
    ])
  })

  it('falls back to bridge index session_key when binding worker_session_id is stale', async () => {
    const { listEnabledBindingsForTranscriptUpdate } = await import('@/lib/human-watch-bindings')
    const rows = listEnabledBindingsForTranscriptUpdate(1, 'real-codex-session', db)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.worker_local_agent_id).toBe(10)
  })
})
