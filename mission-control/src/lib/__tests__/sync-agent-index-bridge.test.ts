import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'

describe('sync-agent-index bridge hybrid', () => {
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

  it('replaces bridge agent index and removes stale rows', async () => {
    const { replaceBridgeAgentIndex, listBridgeAgentIndex, mergeDbAgentsWithBridgeIndex } =
      await import('@/lib/sync-agent-index')

    replaceBridgeAgentIndex('client-a', 'Mac', [
      { id: 1, name: 'Alpha', role: 'coder', status: 'idle' },
      { id: 2, name: 'Beta', role: 'agent', status: 'busy' },
    ])

    expect(listBridgeAgentIndex('client-a')).toHaveLength(2)

    replaceBridgeAgentIndex('client-a', 'Mac', [
      { id: 2, name: 'Beta', role: 'agent', status: 'idle' },
    ])

    const rows = listBridgeAgentIndex('client-a')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.original_name).toBe('Beta')

    const merged = mergeDbAgentsWithBridgeIndex([], rows, () => true)
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ source: 'bridge_index', bridge_online: true })
  })

  it('prefers bridge index over stale client mirror when bridge is online', async () => {
    const { replaceBridgeAgentIndex, listBridgeAgentIndex, mergeDbAgentsWithBridgeIndex } =
      await import('@/lib/sync-agent-index')

    replaceBridgeAgentIndex('client-a', 'Mac', [
      { id: 1, name: 'Alpha', role: 'coder', status: 'busy', framework: 'claude' },
    ])
    const rows = listBridgeAgentIndex('client-a')
    const staleClientMirror = {
      source: 'client',
      node_id: 'client-a',
      name: 'mac-alpha',
      status: 'idle',
      config: { original_name: 'Alpha' },
    }

    const mergedOnline = mergeDbAgentsWithBridgeIndex([staleClientMirror], rows, () => true)
    expect(mergedOnline).toHaveLength(1)
    expect(mergedOnline[0]).toMatchObject({ source: 'bridge_index', status: 'busy' })

    const mergedOffline = mergeDbAgentsWithBridgeIndex([staleClientMirror], rows, () => false)
    expect(mergedOffline).toHaveLength(1)
    expect(mergedOffline[0]).toMatchObject({ source: 'client', status: 'idle' })
  })
})
