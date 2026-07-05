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

