import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'

const requireRole = vi.fn()

vi.mock('@/lib/auth', () => ({ requireRole }))

describe('human-watch interventions route', () => {
  let db: Database.Database

  beforeEach(async () => {
    vi.resetModules()
    db = new Database(':memory:')
    runMigrations(db)
    requireRole.mockReturnValue({ user: { id: 2, workspace_id: 1, tenant_id: 1, role: 'viewer' } })
    vi.doMock('@/lib/db', () => ({ getDatabase: () => db }))
  })

  afterEach(() => {
    db.close()
    vi.clearAllMocks()
  })

  it('returns one correlated trigger-to-ack evidence chain', async () => {
    const { createHumanWatchEvent } = await import('@/lib/human-watch-events')
    const { createEdgeMessage, leaseEdgeMessages, ackEdgeMessage } = await import('@/lib/edge-messages')
    const { logHumanWatchIntervention } = await import('@/lib/human-watch-audit')
    const event = createHumanWatchEvent({
      workspaceId: 1,
      tenantId: 1,
      clientId: 'edge-a',
      workerLocalAgentId: 16,
      workerSessionId: 'session-a',
      source: 'transcript_wait',
      title: '等待确认',
      summary: '请选择颜色',
      priority: 'medium',
    }, db)
    const created = createEdgeMessage({
      id: 'message-a',
      workspaceId: 1,
      tenantId: 1,
      clientId: 'edge-a',
      type: 'session.continue.requested',
      correlationId: 'human-watch:8:session-a:fingerprint-a',
      idempotencyKey: 'human-watch:8:session-a:fingerprint-a',
      sessionRef: { session_id: 'session-a', session_kind: 'codex-cli' },
      payload: {
        human_watch_event_id: event.id,
        human_watch_prompt: '选择绿色主题，确认。',
      },
    }, db)
    leaseEdgeMessages({ clientId: 'edge-a', leaseOwner: 'runtime-a' }, db)
    ackEdgeMessage({
      id: created.message.id,
      clientId: 'edge-a',
      leaseOwner: 'runtime-a',
      result: { delivered: true, reply: '已选择绿色主题，确认。' },
    }, db)
    logHumanWatchIntervention({
      workspaceId: 1,
      tenantId: 1,
      clientId: 'edge-a',
      workerLocalAgentId: 16,
      workerSessionId: 'session-a',
      eventType: 'intervention_completed',
      decision: 'auto_send',
      fingerprint: 'fingerprint-a',
      messageId: created.message.id,
      correlationId: created.message.correlation_id,
      rulesHit: { trigger: 'question' },
      outcome: 'success',
    }, db)

    const { GET } = await import('@/app/api/human-watch/interventions/route')
    const response = await GET(new NextRequest('http://localhost/api/human-watch/interventions?client_id=edge-a'))
    const body = await response.json()
    const row = body.interventions.find((item: { event_type: string }) => item.event_type === 'intervention_completed')

    expect(response.status).toBe(200)
    expect(row.rules_hit).toEqual({ trigger: 'question' })
    expect(row.evidence).toMatchObject({
      watch_event_id: event.id,
      watch_event_status: 'pending',
      message_id: 'message-a',
      correlation_id: 'human-watch:8:session-a:fingerprint-a',
      mailbox_status: 'completed',
      attempt_count: 1,
      worker_reply: '已选择绿色主题，确认。',
      last_error_message: null,
    })
    expect(row.evidence.completed_at).toEqual(expect.any(Number))
    expect(row.evidence.total_duration_seconds).toEqual(expect.any(Number))
  })

  it('keeps an uncorrelated skipped intervention readable', async () => {
    const { logHumanWatchIntervention } = await import('@/lib/human-watch-audit')
    logHumanWatchIntervention({
      workspaceId: 1,
      tenantId: 1,
      clientId: 'edge-a',
      eventType: 'intervention_skipped',
      decision: 'skipped',
      skipReason: 'rate_limited',
      errorMessage: 'Too many attempts',
    }, db)

    const { GET } = await import('@/app/api/human-watch/interventions/route')
    const response = await GET(new NextRequest('http://localhost/api/human-watch/interventions?client_id=edge-a'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.interventions[0].evidence).toMatchObject({
      message_id: null,
      mailbox_status: null,
      worker_reply: null,
      last_error_message: 'Too many attempts',
    })
  })
})
