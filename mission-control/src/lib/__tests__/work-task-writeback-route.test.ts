import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'

const requireRole = vi.fn()
const sendEdgeMessageWakeup = vi.fn()
vi.mock('@/lib/auth', () => ({ requireRole }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: () => null }))
vi.mock('@/lib/bridge-server', () => ({ sendEdgeMessageWakeup }))

describe('local Work task writeback route', () => {
  let db: Database.Database
  beforeEach(() => {
    vi.resetModules()
    db = new Database(':memory:')
    runMigrations(db)
    db.prepare(`INSERT INTO sync_clients (client_id, client_name, workspace_id) VALUES ('edge-a', 'Edge A', 1)`).run()
    requireRole.mockReturnValue({ user: { id: 1, username: 'operator', workspace_id: 1, tenant_id: 1, role: 'operator' } })
    vi.doMock('@/lib/db', () => ({ getDatabase: () => db }))
  })
  afterEach(() => { db.close(); vi.clearAllMocks() })

  it('queues an idempotent task mutation and wakes the owning Edge', async () => {
    const { POST } = await import('@/app/api/tasks/local-mutations/route')
    const payload = { client_id: 'edge-a', local_task_id: 7, expected_updated_at: 100, operation: 'update', changes: { status: 'in_progress' }, idempotency_key: 'request-1' }
    const first = await POST(new NextRequest('http://localhost/api/tasks/local-mutations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }))
    expect(first.status).toBe(202)
    const firstBody = await first.json()
    expect(firstBody).toMatchObject({ accepted: true, duplicate: false, status: 'pending', client_id: 'edge-a', local_task_id: 7 })
    expect(sendEdgeMessageWakeup).toHaveBeenCalledWith('edge-a', expect.objectContaining({ type: 'work.task.mutation.requested' }))

    const second = await POST(new NextRequest('http://localhost/api/tasks/local-mutations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }))
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({ accepted: true, duplicate: true, message_id: firstBody.message_id })
    expect((db.prepare(`SELECT COUNT(*) AS count FROM edge_messages`).get() as { count: number }).count).toBe(1)
  })

  it('rejects unsupported mutation fields before queueing', async () => {
    const { POST } = await import('@/app/api/tasks/local-mutations/route')
    const response = await POST(new NextRequest('http://localhost/api/tasks/local-mutations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: 'edge-a', local_task_id: 7, expected_updated_at: 100, operation: 'update', changes: { metadata: { unsafe: true } }, idempotency_key: 'request-2' }) }))
    expect(response.status).toBe(400)
    expect((db.prepare(`SELECT COUNT(*) AS count FROM edge_messages`).get() as { count: number }).count).toBe(0)
  })
})
