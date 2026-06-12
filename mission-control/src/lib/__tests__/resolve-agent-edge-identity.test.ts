import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'

describe('resolveAgentEdgeIdentity', () => {
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

  it('resolves by sync index id and by remote_name', async () => {
    const { replaceBridgeAgentIndex } = await import('@/lib/sync-agent-index')
    const { resolveAgentEdgeIdentity } = await import('@/lib/resolve-agent-edge-identity')

    replaceBridgeAgentIndex('mc-local-test', 'Mac', [
      { id: 3, name: '人工值守 Agent', role: 'human-watch', status: 'idle', framework: 'codex-cli' },
      { id: 7, name: '程序+人工值守测试', role: 'coder', status: 'idle', framework: 'codex-cli' },
    ])

    const rows = db
      .prepare(`SELECT id, remote_name FROM sync_agent_index WHERE client_id = ?`)
      .all('mc-local-test') as Array<{ id: number; remote_name: string }>
    const stewardRow = rows.find((r) => r.remote_name.includes('人工值守 Agent'))
    expect(stewardRow).toBeDefined()

    const byId = resolveAgentEdgeIdentity({ id: stewardRow!.id })
    expect(byId.client_id).toBe('mc-local-test')
    expect(byId.local_agent_id).toBe(3)

    const byName = resolveAgentEdgeIdentity({ name: stewardRow!.remote_name })
    expect(byName.local_agent_id).toBe(3)
  })
})
