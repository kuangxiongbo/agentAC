import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveBridgeClientWorkspaceId, upsertBridgeAgentInventory } from '../bridge-agent-registration'
import { runMigrations } from '../migrations'

const databases: Database.Database[] = []

describe('bridge agent registration', () => {
  afterEach(() => {
    for (const db of databases.splice(0)) db.close()
  })

  it('upserts by name and workspace after migration 071', () => {
    const db = new Database(':memory:')
    databases.push(db)
    runMigrations(db)
    db.prepare(`INSERT INTO workspaces (id, slug, name, tenant_id) VALUES (2, 'bridge-two', 'Bridge Two', 1)`).run()
    db.prepare(`INSERT INTO sync_clients (client_id, client_name, workspace_id) VALUES ('edge-two', 'Edge Two', 2)`).run()
    db.prepare(`INSERT INTO agents (name, role, workspace_id, status) VALUES ('edge-two-worker', 'existing', 1, 'idle')`).run()

    const workspaceId = resolveBridgeClientWorkspaceId(db, 'edge-two')
    expect(workspaceId).toBe(2)
    upsertBridgeAgentInventory(db, {
      clientId: 'edge-two',
      clientLabel: 'Edge Two',
      workspaceId,
      now: 100,
      agents: [{ id: 7, name: 'worker', role: 'coder', status: 'busy', framework: 'codex' }],
    })
    upsertBridgeAgentInventory(db, {
      clientId: 'edge-two',
      clientLabel: 'Edge Two',
      workspaceId,
      now: 200,
      agents: [{ id: 7, name: 'worker', role: 'reviewer', status: 'idle', framework: 'claude' }],
    })

    const rows = db.prepare(`SELECT workspace_id, role, status, framework, updated_at FROM agents WHERE name = 'edge-two-worker' ORDER BY workspace_id`).all()
    expect(rows).toEqual([
      expect.objectContaining({ workspace_id: 1, role: 'existing', status: 'idle' }),
      expect.objectContaining({ workspace_id: 2, role: 'reviewer', status: 'idle', framework: 'claude', updated_at: 200 }),
    ])
  })
})
