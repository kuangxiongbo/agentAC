import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'

const requireRole = vi.fn()
const mutationLimiter = vi.fn(() => null)
const requireHumanWatchEntitlement = vi.fn()

vi.mock('@/lib/auth', () => ({
  requireRole,
}))

vi.mock('@/lib/rate-limit', () => ({
  mutationLimiter,
}))

vi.mock('@/lib/human-watch-policy', () => ({
  requireHumanWatchEntitlement,
}))

describe('human-watch assist route queued delivery', () => {
  let db: Database.Database

  beforeEach(() => {
    vi.resetModules()
    db = new Database(':memory:')
    runMigrations(db)
    requireRole.mockReturnValue({
      user: {
        id: 2,
        workspace_id: 1,
        tenant_id: 1,
        role: 'operator',
        portal_tenant_role: 'admin',
      },
    })
    mutationLimiter.mockReturnValue(null)
    requireHumanWatchEntitlement.mockResolvedValue({ ok: true })

    vi.doMock('@/lib/db', () => ({
      getDatabase: () => db,
    }))
  })

  afterEach(() => {
    db.close()
    vi.clearAllMocks()
    delete process.env.MC_RELIABLE_EDGE_MESSAGES
  })

  it('queues a human-watch assist request with steward and worker session payload', async () => {
    db.prepare(`
      INSERT INTO human_watch_bindings (
        id, workspace_id, tenant_id, client_id,
        worker_local_agent_id, worker_name,
        steward_local_agent_id, steward_name,
        worker_session_id, enabled, mode
      ) VALUES (
        1, 1, 1, 'edge-test',
        11, 'Worker Agent',
        22, '值守 Agent',
        'worker-session-1', 1, 'auto_send'
      )
    `).run()

    const { POST } = await import('@/app/api/human-watch/assist/route')
    const request = new NextRequest('http://localhost/api/human-watch/assist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        delivery_mode: 'queue',
        client_id: 'edge-test',
        binding_id: 1,
        worker_local_agent_id: 11,
        worker_session_id: 'worker-session-1',
        session_kind: 'codex-cli',
        prompt: 'Worker 已回复，需要值守 Agent 继续确认。',
      }),
    })

    const response = await POST(request)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.delivery).toMatchObject({
      mode: 'queued',
      queued: true,
      delivered: false,
      binding_id: 1,
    })
    expect(body.delivery.message_id).toBeTruthy()
    expect(body.delivery.correlation_id).toContain('hw-assist:1:worker-session-1')

    const queued = db.prepare(`SELECT * FROM edge_messages WHERE id = ?`)
      .get(body.delivery.message_id) as { type: string; payload_json: string; session_ref_json: string; status: string }
    expect(queued.status).toBe('pending')
    expect(queued.type).toBe('human_watch.assist.requested')
    expect(JSON.parse(queued.session_ref_json)).toMatchObject({
      session_id: 'worker-session-1',
      session_kind: 'codex-cli',
      serial_key: 'edge-test:codex-cli:worker-session-1',
    })
    expect(JSON.parse(queued.payload_json)).toMatchObject({
      binding_id: 1,
      client_id: 'edge-test',
      worker_local_agent_id: 11,
      worker_session_id: 'worker-session-1',
      session_kind: 'codex-cli',
      steward_local_agent_id: 22,
      steward_name: '值守 Agent',
      prompt: 'Worker 已回复，需要值守 Agent 继续确认。',
    })
  })
})
