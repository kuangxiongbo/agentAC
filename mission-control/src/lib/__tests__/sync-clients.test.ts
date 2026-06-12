import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'

describe('sync clients workspace scoping', () => {
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

  it('lists only clients in the requested workspace', async () => {
    const { listSyncClients, upsertSyncClientHeartbeat } = await import('@/lib/sync-clients')

    upsertSyncClientHeartbeat({
      clientId: 'client-a',
      clientName: 'workspace-a-mac',
      workspaceId: 1,
      source: 'heartbeat',
      agentCount: 2,
    })
    upsertSyncClientHeartbeat({
      clientId: 'client-b',
      clientName: 'workspace-b-mac',
      workspaceId: 2,
      source: 'heartbeat',
      agentCount: 3,
    })

    expect(listSyncClients(1).map((client) => client.client_id)).toEqual(['client-a'])
    expect(listSyncClients(2).map((client) => client.client_id)).toEqual(['client-b'])
  })
})
