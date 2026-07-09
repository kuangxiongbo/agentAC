import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'
import {
  ackEdgeMessage,
  cancelEdgeMessage,
  createEdgeMessage,
  failEdgeMessage,
  leaseEdgeMessages,
  listEdgeMessageEvents,
  listEdgeMessages,
} from '@/lib/edge-messages'

describe('edge-messages', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
  })

  afterEach(() => {
    db.close()
  })

  function createBase(overrides: Partial<Parameters<typeof createEdgeMessage>[0]> = {}) {
    return createEdgeMessage(
      {
        workspaceId: 1,
        tenantId: 1,
        clientId: 'mc-edge-1',
        type: 'human_watch.assist.requested',
        correlationId: 'corr-1',
        idempotencyKey: 'idem-1',
        sessionRef: {
          session_id: 'session-1',
          session_kind: 'codex-cli',
          serial_key: 'mc-edge-1:codex-cli:session-1',
        },
        payload: { prompt: 'help' },
        ...overrides,
      },
      db,
    )
  }

  it('creates and lists pending messages', () => {
    const created = createBase()
    expect(created.created).toBe(true)
    expect(created.duplicate).toBe(false)
    expect(created.message.status).toBe('pending')
    expect(created.message.payload.prompt).toBe('help')

    const rows = listEdgeMessages({ workspaceId: 1, tenantId: 1, status: 'pending' }, db)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(created.message.id)

    const events = listEdgeMessageEvents(created.message.id, db)
    expect(events).toHaveLength(1)
  })

  it('deduplicates by tenant, client, and idempotency key', () => {
    const first = createBase()
    const second = createBase({ payload: { prompt: 'different' } })

    expect(second.created).toBe(false)
    expect(second.duplicate).toBe(true)
    expect(second.message.id).toBe(first.message.id)
    expect(second.message.payload.prompt).toBe('help')
  })

  it('leases and acknowledges a message', () => {
    const created = createBase()
    const leased = leaseEdgeMessages({ clientId: 'mc-edge-1', leaseOwner: 'runtime-1' }, db)

    expect(leased).toHaveLength(1)
    expect(leased[0]?.id).toBe(created.message.id)
    expect(leased[0]?.status).toBe('leased')
    expect(leased[0]?.attempt_count).toBe(1)

    const acked = ackEdgeMessage(
      {
        id: created.message.id,
        clientId: 'mc-edge-1',
        leaseOwner: 'runtime-1',
        result: { delivered: true },
      },
      db,
    )

    expect(acked.status).toBe('completed')
    expect(acked.result?.delivered).toBe(true)
    expect(acked.lease_owner).toBeNull()
    expect(acked.completed_at).toBeTypeOf('number')
  })

  it('records human-watch assist completion when a queued message is acknowledged', () => {
    db.prepare(`
      INSERT INTO human_watch_bindings (
        id, workspace_id, tenant_id, client_id,
        worker_local_agent_id, worker_name,
        steward_local_agent_id, steward_name,
        worker_session_id, worker_session_kind, enabled, mode
      ) VALUES (
        3, 1, 1, 'mc-edge-1',
        6, 'Worker',
        7, '值守 Agent',
        'session-1', 'codex-cli', 1, 'auto_send'
      )
    `).run()

    const created = createBase({
      payload: {
        binding_id: 3,
        client_id: 'mc-edge-1',
        worker_local_agent_id: 6,
        worker_name: 'Worker',
        worker_session_id: 'session-1',
        session_kind: 'codex-cli',
        steward_local_agent_id: 7,
        steward_name: '值守 Agent',
        prompt: 'Worker 正在等待用户确认。',
      },
    })
    leaseEdgeMessages({ clientId: 'mc-edge-1', leaseOwner: 'runtime-1' }, db)

    ackEdgeMessage(
      {
        id: created.message.id,
        clientId: 'mc-edge-1',
        leaseOwner: 'runtime-1',
        result: {
          delivered: true,
          steward_reply: '继续，按当前方案推进。',
          steward_session_id: 'steward-session-1',
        },
      },
      db,
    )

    const row = db.prepare(`
      SELECT * FROM human_watch_interventions
      WHERE message_id = ? AND event_type = 'intervention_completed'
    `).get(created.message.id) as {
      binding_id: number
      worker_local_agent_id: number
      steward_local_agent_id: number
      event_type: string
      outcome: string
      prompt_preview: string
      message_id: string
      correlation_id: string
    } | undefined

    expect(row).toMatchObject({
      binding_id: 3,
      worker_local_agent_id: 6,
      steward_local_agent_id: 7,
      event_type: 'intervention_completed',
      outcome: 'success',
      prompt_preview: '继续，按当前方案推进。',
      message_id: created.message.id,
      correlation_id: 'corr-1',
    })
  })

  it('rejects ack from a different lease owner', () => {
    const created = createBase()
    leaseEdgeMessages({ clientId: 'mc-edge-1', leaseOwner: 'runtime-1' }, db)

    expect(() =>
      ackEdgeMessage(
        {
          id: created.message.id,
          clientId: 'mc-edge-1',
          leaseOwner: 'runtime-2',
        },
        db,
      ),
    ).toThrow('lease owner mismatch')
  })

  it('marks retryable failure and leases again after next_attempt_at', () => {
    const created = createBase({ maxAttempts: 2 })
    leaseEdgeMessages({ clientId: 'mc-edge-1', leaseOwner: 'runtime-1' }, db)

    const failed = failEdgeMessage(
      {
        id: created.message.id,
        clientId: 'mc-edge-1',
        leaseOwner: 'runtime-1',
        errorCode: 'TEMP',
        errorMessage: 'temporary',
        retryable: true,
        nextAttemptAt: 1,
      },
      db,
    )
    expect(failed.status).toBe('failed_retryable')
    expect(failed.last_error_code).toBe('TEMP')

    const leasedAgain = leaseEdgeMessages({ clientId: 'mc-edge-1', leaseOwner: 'runtime-2' }, db)
    expect(leasedAgain).toHaveLength(1)
    expect(leasedAgain[0]?.attempt_count).toBe(2)
  })

  it('moves to dead letter when attempts are exhausted', () => {
    const created = createBase({ maxAttempts: 1 })
    leaseEdgeMessages({ clientId: 'mc-edge-1', leaseOwner: 'runtime-1' }, db)

    const failed = failEdgeMessage(
      {
        id: created.message.id,
        clientId: 'mc-edge-1',
        leaseOwner: 'runtime-1',
        errorCode: 'PERMANENT',
        errorMessage: 'no session',
        retryable: true,
      },
      db,
    )

    expect(failed.status).toBe('dead_letter')
  })

  it('cancels pending messages', () => {
    const created = createBase()
    const cancelled = cancelEdgeMessage({ id: created.message.id, workspaceId: 1, reason: 'operator' }, db)
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.cancelled_at).toBeTypeOf('number')
  })

  it('leases only one message per serial key at a time', () => {
    createBase({ idempotencyKey: 'idem-1', payload: { prompt: 'first' } })
    createBase({ idempotencyKey: 'idem-2', payload: { prompt: 'second' } })

    const leased = leaseEdgeMessages({ clientId: 'mc-edge-1', leaseOwner: 'runtime-1', limit: 2 }, db)
    expect(leased).toHaveLength(1)
    expect(leased[0]?.payload.prompt).toBe('first')

    ackEdgeMessage({ id: leased[0]!.id, clientId: 'mc-edge-1', leaseOwner: 'runtime-1' }, db)

    const leasedSecond = leaseEdgeMessages({ clientId: 'mc-edge-1', leaseOwner: 'runtime-1', limit: 2 }, db)
    expect(leasedSecond).toHaveLength(1)
    expect(leasedSecond[0]?.payload.prompt).toBe('second')
  })
})
