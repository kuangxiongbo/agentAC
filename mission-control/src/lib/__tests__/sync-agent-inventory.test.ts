import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildInventoryMatchSets,
  buildRemoteAgentRegistrationName,
  cleanupDuplicateClientAgents,
  parseAgentInventory,
  shouldRetainClientSyncedAgent,
} from '@/lib/sync-agent-inventory'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'

describe('sync-agent-inventory', () => {
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

  it('parses agent_inventory payloads', () => {
    expect(
      parseAgentInventory([
        { original_name: 'Alpha', status: 'idle' },
        { original_name: '' },
        null,
      ]),
    ).toEqual([{ original_name: 'Alpha', status: 'idle' }])
  })

  it('matches by original_name and legacy remote name', () => {
    const clientName = 'My Mac'
    const inventory = [{ original_name: 'Coder' }]
    const matchSets = buildInventoryMatchSets(clientName, inventory)
    const remoteName = buildRemoteAgentRegistrationName(clientName, 'Coder')

    expect(
      shouldRetainClientSyncedAgent(
        { name: remoteName, config: JSON.stringify({ original_name: 'Coder' }) },
        matchSets,
      ),
    ).toBe(true)

    expect(
      shouldRetainClientSyncedAgent(
        { name: remoteName, config: '{}' },
        matchSets,
      ),
    ).toBe(true)

    expect(
      shouldRetainClientSyncedAgent(
        { name: 'my-mac-stale', config: JSON.stringify({ original_name: 'Stale' }) },
        matchSets,
      ),
    ).toBe(false)
  })

  it('matches by local_agent_id when present', () => {
    const clientName = 'My Mac'
    const inventory = [{ local_agent_id: 7, original_name: 'Coder' }]
    const matchSets = buildInventoryMatchSets(clientName, inventory)

    expect(
      shouldRetainClientSyncedAgent(
        { name: 'whatever', config: JSON.stringify({ local_agent_id: 7, original_name: 'Old Name' }) },
        matchSets,
      ),
    ).toBe(true)

    expect(
      shouldRetainClientSyncedAgent(
        { name: 'whatever', config: JSON.stringify({ local_agent_id: 9, original_name: 'Coder' }) },
        matchSets,
      ),
    ).toBe(true)
  })

  it('cleans up duplicate client agents and keeps the newest row', async () => {
    db.prepare(`
      INSERT INTO agents (id, name, role, status, config, created_at, updated_at, last_seen, workspace_id, source, node_id)
      VALUES (?, ?, 'assistant', 'idle', ?, ?, ?, ?, 1, 'client', 'client-a')
    `).run(1, 'old-agent', JSON.stringify({ original_name: '24 小时智能值守', local_agent_id: 9 }), 100, 100, 100)
    db.prepare(`
      INSERT INTO agents (id, name, role, status, config, created_at, updated_at, last_seen, workspace_id, source, node_id)
      VALUES (?, ?, 'assistant', 'idle', ?, ?, ?, ?, 1, 'client', 'client-a')
    `).run(2, 'new-agent', JSON.stringify({ original_name: '24 小时智能值守', local_agent_id: 9 }), 200, 200, 200)

    const { cleanupDuplicateClientAgents } = await import('@/lib/sync-agent-inventory')
    const result = cleanupDuplicateClientAgents(1, 'client-a')
    expect(result.removed).toBe(1)

    const rows = db.prepare(`
      SELECT id, name
      FROM agents
      WHERE workspace_id = 1 AND source = 'client' AND node_id = 'client-a'
      ORDER BY id
    `).all() as Array<{ id: number; name: string }>
    expect(rows).toEqual([{ id: 2, name: 'new-agent' }])
  })

  it('removes only legacy bridge rows represented by the live index', async () => {
    db.prepare(`INSERT INTO sync_clients (client_id, client_name, workspace_id) VALUES ('client-a', 'Mac', 1)`).run()
    db.prepare(`
      INSERT INTO sync_agent_index (
        client_id, client_name, local_agent_id, original_name, remote_name,
        role, status, updated_at
      ) VALUES ('client-a', 'Mac', 9, '值守云端', 'client-a-值守云端', 'human-watch', 'idle', 100)
    `).run()
    db.prepare(`
      INSERT INTO agents (name, role, status, workspace_id, source, node_id)
      VALUES
        ('client-a-值守云端', 'human-watch', 'offline', 1, 'bridge', 'client-a'),
        ('client-a-unmatched', 'agent', 'offline', 1, 'bridge', 'client-a'),
        ('client-a-值守云端-copy', 'agent', 'offline', 1, 'bridge', 'client-b')
    `).run()

    const { cleanupLegacyBridgeAgents } = await import('@/lib/sync-agent-inventory')
    expect(cleanupLegacyBridgeAgents(1, 'client-a')).toEqual({ removed: 1 })
    expect(db.prepare(`SELECT name FROM agents ORDER BY name`).all()).toEqual([
      { name: 'client-a-unmatched' },
      { name: 'client-a-值守云端-copy' },
    ])
  })
})
