import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../migrations'

const databases: Database.Database[] = []
describe('workspace audit and agent identity migration', () => {
  afterEach(() => {
    for (const db of databases.splice(0)) db.close()
  })

  it('preserves agent extensions and scopes identity to workspace', () => {
    const db = new Database(':memory:')
    databases.push(db)
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    runMigrations(db)

    const columns = (db.prepare('PRAGMA table_info(agents)').all() as Array<{ name: string }>).map((row) => row.name)
    expect(columns).toEqual(expect.arrayContaining(['node_id', 'framework', 'parent_id', 'working_memory']))
    expect(db.pragma('foreign_key_check')).toEqual([])

    db.prepare(`INSERT INTO workspaces (id, slug, name, tenant_id) VALUES (2, 'second', 'Second', 1)`).run()
    db.prepare(`INSERT INTO agents (name, role, workspace_id, framework) VALUES ('worker', 'dev', 1, 'claude')`).run()
    db.prepare(`INSERT INTO agents (name, role, workspace_id, framework) VALUES ('worker', 'dev', 2, 'codex')`).run()
    expect(() => db.prepare(`INSERT INTO agents (name, role, workspace_id) VALUES ('worker', 'dev', 2)`).run())
      .toThrow()
  })

  it('adds workspace ownership to legacy audit rows', () => {
    const db = new Database(':memory:')
    databases.push(db)
    runMigrations(db)
    const columns = db.prepare('PRAGMA table_info(audit_log)').all() as Array<{ name: string }>
    expect(columns.some((column) => column.name === 'workspace_id')).toBe(true)
    expect(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_audit_log_workspace_created'`).get())
      .toBeTruthy()
  })
})
