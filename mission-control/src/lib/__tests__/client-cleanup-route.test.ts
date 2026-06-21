import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { runMigrations } from '@/lib/migrations'

const requireRole = vi.fn()

vi.mock('@/lib/auth', () => ({
  requireRole,
}))

describe('client cleanup route', () => {
  let db: Database.Database

  beforeEach(() => {
    vi.resetModules()
    db = new Database(':memory:')
    runMigrations(db)
    requireRole.mockReturnValue({ user: { id: 1, workspace_id: 1, role: 'operator' } })
    vi.doMock('@/lib/db', () => ({
      getDatabase: () => db,
    }))
  })

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })

  it('deletes disconnected client mirrored data when no bindings remain', async () => {
    db.prepare(`
      INSERT INTO sync_clients (client_id, client_name, workspace_id, agent_count, last_seen, last_sync_source, created_at, updated_at)
      VALUES ('client-a', 'Client A', 1, 2, 100, 'heartbeat', 100, 100)
    `).run()
    db.prepare(`
      INSERT INTO sync_agent_index (client_id, client_name, local_agent_id, original_name, remote_name, role, status, framework, parent_local_id, session_key, updated_at)
      VALUES ('client-a', 'Client A', 9, '安全专家', 'client-a-安全专家', 'human-watch', 'offline', 'codex-cli', NULL, NULL, 100)
    `).run()
    db.prepare(`
      INSERT INTO sync_sessions (
        client_id, client_name, session_id, session_key, session_kind,
        runtime_group, agent, model, tokens, age, active, start_time, last_activity, working_dir, last_user_prompt, created_at, updated_at
      )
      VALUES ('client-a', 'Client A', 's1', 's1', 'codex-cli', NULL, 'label', NULL, NULL, NULL, 0, 100, 100, NULL, NULL, 100, 100)
    `).run()
    db.prepare(`
      INSERT INTO agents (id, name, role, status, config, created_at, updated_at, last_seen, workspace_id, source, node_id)
      VALUES (1, 'client-a-安全专家', 'human-watch', 'offline', ?, 100, 100, 100, 1, 'client', 'client-a')
    `).run(JSON.stringify({ original_name: '安全专家', local_agent_id: 9, agent_kind: 'human_watch' }))

    const { DELETE } = await import('@/app/api/clients/[clientId]/cleanup/route')
    const req = new NextRequest('http://localhost/api/clients/client-a/cleanup?confirm=delete-client-data', {
      method: 'DELETE',
    })
    const res = await DELETE(req, { params: Promise.resolve({ clientId: 'client-a' }) })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.removed_agents).toBe(1)
    expect(body.removed_sessions).toBe(1)
    expect((db.prepare(`SELECT COUNT(*) as c FROM sync_clients WHERE client_id='client-a'`).get() as any).c).toBe(0)
    expect((db.prepare(`SELECT COUNT(*) as c FROM sync_agent_index WHERE client_id='client-a'`).get() as any).c).toBe(0)
    expect((db.prepare(`SELECT COUNT(*) as c FROM sync_sessions WHERE client_id='client-a'`).get() as any).c).toBe(0)
    expect((db.prepare(`SELECT COUNT(*) as c FROM agents WHERE source='client' AND node_id='client-a'`).get() as any).c).toBe(0)
  })

  it('blocks deletion when human-watch bindings still exist', async () => {
    db.prepare(`
      INSERT INTO human_watch_bindings (
        workspace_id, client_id, worker_local_agent_id, steward_local_agent_id, worker_name, steward_name,
        worker_session_id, enabled, mode, created_at, updated_at
      ) VALUES (1, 'client-a', 5, 9, 'worker', 'steward', 'sess-1', 1, 'auto_send', 100, 100)
    `).run()

    const { DELETE } = await import('@/app/api/clients/[clientId]/cleanup/route')
    const req = new NextRequest('http://localhost/api/clients/client-a/cleanup?confirm=delete-client-data', {
      method: 'DELETE',
    })
    const res = await DELETE(req, { params: Promise.resolve({ clientId: 'client-a' }) })
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(String(body.error)).toContain('human-watch bindings')
  })
})
