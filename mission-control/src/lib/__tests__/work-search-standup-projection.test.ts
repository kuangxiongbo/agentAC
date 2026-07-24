import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'

const requireRole = vi.fn(() => ({ user: { id: 1, username: 'tester', workspace_id: 1, role: 'admin' } }))
const requestBridgeClientWorkSearch = vi.fn()
const requestBridgeClientStandupSnapshot = vi.fn()

vi.mock('@/lib/auth', () => ({ requireRole }))
vi.mock('@/lib/rate-limit', () => ({ heavyLimiter: vi.fn(() => null) }))
vi.mock('@/lib/bridge-server', () => ({
  getConnectedBridgeClients: () => [{ clientId: 'edge-a', clientLabel: 'Edge A', capabilities: ['work_search', 'standup_snapshot'] }],
  requestBridgeClientWorkSearch,
  requestBridgeClientStandupSnapshot,
}))

describe('Work search and standup projection', () => {
  let db: Database.Database

  beforeEach(() => {
    vi.resetModules()
    db = new Database(':memory:')
    runMigrations(db)
    db.prepare(`INSERT INTO sync_clients (client_id, client_name, workspace_id) VALUES ('edge-a', 'Edge A', 1)`).run()
    db.prepare(`INSERT INTO sync_agent_index (client_id, client_name, local_agent_id, original_name, remote_name, role, status, framework)
      VALUES ('edge-a', 'Edge A', 10, 'Worker', 'edge-a-Worker', 'worker', 'busy', 'codex-cli')`).run()
    vi.doMock('@/lib/db', () => ({ getDatabase: () => db, db_helpers: { logActivity: vi.fn() } }))
    requestBridgeClientWorkSearch.mockResolvedValue({ source: 'local_runtime', truncated: false, results: [{
      type: 'task', local_id: 7, title: 'Unique local task', subtitle: 'in_progress · Worker', excerpt: 'Edge fact', agent_name: 'Worker', created_at: 100, relevance: 2,
    }] })
    requestBridgeClientStandupSnapshot.mockResolvedValue({ source: 'local_runtime', agents: [{ name: 'Worker', role: 'worker', status: 'busy' }], tasks: [{
      id: 7, title: 'Unique local task', status: 'in_progress', priority: 'high', assigned_to: 'Worker', created_at: 100, updated_at: 200,
    }], activityCounts: { Worker: 3 } })
  })

  it('merges mapped Edge results into global search', async () => {
    const route = await import('@/app/api/search/route')
    const response = await route.GET(new NextRequest('http://localhost/api/search?q=Unique&limit=20'))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ authority: 'combined', local_live: true, local_errors: [] })
    expect(body.results).toEqual([expect.objectContaining({
      type: 'task', title: 'Unique local task', source: 'local_runtime', authority: 'local_runtime',
      client_id: 'edge-a', local_entity_id: 7, agent_name: 'edge-a-Worker', original_agent_name: 'Worker',
    })])
    expect(body.results[0].id).toBeLessThan(0)
  })

  it('includes Edge Work facts in a persisted standup', async () => {
    const route = await import('@/app/api/standup/route')
    const response = await route.POST(new NextRequest('http://localhost/api/standup', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ date: '1970-01-01' }),
    }))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.standup.sources).toMatchObject({ authority: 'combined', local_live: true, errors: [] })
    expect(body.standup.agentReports).toEqual([expect.objectContaining({
      agent: expect.objectContaining({ name: 'edge-a-Worker', original_name: 'Worker', source: 'local_runtime' }),
      inProgress: [expect.objectContaining({ title: 'Unique local task', source: 'local_runtime' })],
      activity: { actionCount: 3, commentsCount: 0 },
    })])
    expect(db.prepare('SELECT COUNT(*) AS count FROM standup_reports').get()).toEqual({ count: 1 })
  })
})
