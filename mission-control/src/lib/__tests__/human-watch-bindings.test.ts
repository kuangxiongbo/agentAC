import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'
import {
  getHumanWatchBinding,
  listHumanWatchBindings,
  updateHumanWatchBinding,
} from '@/lib/human-watch-bindings'

describe('human-watch-bindings', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
    db.prepare(
      `INSERT INTO human_watch_bindings (
        workspace_id, tenant_id, client_id,
        worker_sync_index_id, worker_local_agent_id, worker_name,
        steward_sync_index_id, steward_local_agent_id, steward_name,
        enabled, mode, created_at, updated_at
      ) VALUES (1, 1, 'mac-1', 10, 5, 'w-remote', 11, 9, 's-remote', 1, 'auto_send', 1, 1)`,
    ).run()
  })

  afterEach(() => {
    db.close()
  })

  it('lists bindings by workspace and client', () => {
    const rows = listHumanWatchBindings({ workspaceId: 1, clientId: 'mac-1' }, db)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.worker_local_agent_id).toBe(5)
  })

  it('updates enabled and mode', () => {
    const row = getHumanWatchBinding(1, 1, db)
    expect(row).not.toBeNull()

    const updated = updateHumanWatchBinding(1, 1, {
      enabled: false,
      mode: 'suggest_only',
      rulesOverride: { idle_timeout_seconds: 120 },
    }, db)

    expect(updated?.enabled).toBe(0)
    expect(updated?.mode).toBe('suggest_only')
    expect(updated?.rules_override).toContain('idle_timeout_seconds')
  })
})
