import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'

vi.mock('@/lib/edge-client-identity', () => ({
  resolveLocalClientId: (db: Database.Database) => {
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'device.client_id'`).get() as { value?: string } | undefined
    return row?.value || 'mc-node-static'
  },
}))

import {
  enqueuePermissionDecisionSync,
  getLocalMailboxStatus,
  processInbox,
  registerLocalMessageHandler,
} from '@/lib/local-mailbox'

describe('local-mailbox', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
    db.prepare(`INSERT OR REPLACE INTO settings (key, value, category) VALUES ('device.client_id', 'edge-test', 'device')`).run()
  })

  afterEach(() => {
    db.close()
  })

  function insertInbox(
    type: string,
    messageId = `msg-${type}`,
    options: { idempotencyKey?: string; serialKey?: string | null; receivedAt?: number } = {},
  ) {
    db.prepare(`
      INSERT INTO local_message_inbox (
        message_id, client_id, type, status, idempotency_key,
        serial_key, payload_json, lease_owner, lease_expires_at, received_at
      ) VALUES (?, 'edge-test', ?, 'pending', ?, ?, ?, 'lease-1', 9999999999, ?)
    `).run(
      messageId,
      type,
      options.idempotencyKey ?? `idem-${messageId}`,
      options.serialKey ?? null,
      JSON.stringify({ prompt: 'hello' }),
      options.receivedAt ?? 1,
    )
    return messageId
  }

  it('executes a registered handler and records ack outbox', async () => {
    const type = 'test.local_mailbox.ok'
    const messageId = insertInbox(type)
    registerLocalMessageHandler(type, (message) => ({
      ok: true,
      result: { echoed: message.payload.prompt },
    }))

    const result = await processInbox(db)
    expect(result.executed).toBe(1)
    expect(result.failed).toBe(0)

    const inbox = db.prepare(`SELECT * FROM local_message_inbox WHERE message_id = ?`).get(messageId) as {
      status: string
      result_json: string
    }
    expect(inbox.status).toBe('completed')
    expect(JSON.parse(inbox.result_json).echoed).toBe('hello')

    const outbox = db.prepare(`SELECT * FROM local_message_outbox WHERE message_id = ?`).get(messageId) as {
      action: string
      status: string
    }
    expect(outbox.action).toBe('ack')
    expect(outbox.status).toBe('pending')
  })

  it('records unsupported message types as fail outbox', async () => {
    const messageId = insertInbox('test.local_mailbox.unsupported')

    const result = await processInbox(db)
    expect(result.executed).toBe(0)
    expect(result.failed).toBe(1)

    const inbox = db.prepare(`SELECT * FROM local_message_inbox WHERE message_id = ?`).get(messageId) as {
      status: string
      last_error: string
    }
    expect(inbox.status).toBe('failed')
    expect(inbox.last_error).toContain('Unsupported local mailbox message type')

    const outbox = db.prepare(`SELECT * FROM local_message_outbox WHERE message_id = ?`).get(messageId) as {
      action: string
      payload_json: string
    }
    expect(outbox.action).toBe('fail')
    expect(JSON.parse(outbox.payload_json).error_code).toBe('UNSUPPORTED_MESSAGE_TYPE')
  })

  it('reports local mailbox status', () => {
    insertInbox('test.local_mailbox.status')
    const status = getLocalMailboxStatus(db)
    expect(status.client_id).toBe('edge-test')
    expect(status.inbox.pending).toBe(1)
    expect(status.outbox.pending).toBe(0)
  })

  it('acks duplicate idempotency keys without running the handler again', async () => {
    const type = 'test.local_mailbox.duplicate'
    let calls = 0
    registerLocalMessageHandler(type, () => {
      calls++
      return { ok: true, result: { calls } }
    })

    insertInbox(type, 'msg-dup-1', { idempotencyKey: 'idem-dup' })
    expect(await processInbox(db)).toEqual({ executed: 1, failed: 0 })
    insertInbox(type, 'msg-dup-2', { idempotencyKey: 'idem-dup' })
    expect(await processInbox(db)).toEqual({ executed: 1, failed: 0 })

    expect(calls).toBe(1)
    const duplicateOutbox = db.prepare(`
      SELECT payload_json FROM local_message_outbox
      WHERE message_id = 'msg-dup-2' AND action = 'ack'
    `).get() as { payload_json: string }
    expect(JSON.parse(duplicateOutbox.payload_json)).toMatchObject({
      duplicate: true,
      result: { calls: 1 },
    })
  })

  it('processes only one pending message for the same serial key per pass', async () => {
    const type = 'test.local_mailbox.serial'
    const processed: string[] = []
    registerLocalMessageHandler(type, (message) => {
      processed.push(message.id)
      return { ok: true, result: { id: message.id } }
    })

    insertInbox(type, 'msg-serial-1', {
      idempotencyKey: 'idem-serial-1',
      serialKey: 'edge-test:codex-cli:session-1',
      receivedAt: 1,
    })
    insertInbox(type, 'msg-serial-2', {
      idempotencyKey: 'idem-serial-2',
      serialKey: 'edge-test:codex-cli:session-1',
      receivedAt: 2,
    })

    expect(await processInbox(db)).toEqual({ executed: 1, failed: 0 })
    expect(processed).toEqual(['msg-serial-1'])

    const second = db.prepare(`SELECT status FROM local_message_inbox WHERE message_id = 'msg-serial-2'`)
      .get() as { status: string }
    expect(second.status).toBe('pending')

    expect(await processInbox(db)).toEqual({ executed: 1, failed: 0 })
    expect(processed).toEqual(['msg-serial-1', 'msg-serial-2'])
  })

  it('queues permission decision sync into local outbox', () => {
    const queued = enqueuePermissionDecisionSync({
      requestId: 'pr-1',
      optionId: 'approve',
      reason: 'approved by steward',
      deciderType: 'steward_agent',
      deciderAgentId: 'agent-9',
      idempotencyKey: 'decision-pr-1-approve',
    }, db)

    expect(queued).toBe(true)
    const outbox = db.prepare(`
      SELECT action, payload_json FROM local_message_outbox
      WHERE message_id = 'pr-1'
    `).get() as { action: string; payload_json: string }
    expect(outbox.action).toBe('permission_decision_sync')
    expect(JSON.parse(outbox.payload_json)).toMatchObject({
      request_id: 'pr-1',
      option_id: 'approve',
      decider_type: 'steward_agent',
      decider_agent_id: 'agent-9',
      idempotency_key: 'decision-pr-1-approve',
    })
  })

  it('applies a versioned local task mutation and records an ack', async () => {
    const created = db.prepare(`INSERT INTO tasks (title, status, priority, created_by, created_at, updated_at, workspace_id)
      VALUES ('Before', 'assigned', 'medium', 'test', 100, 100, 1)`).run()
    db.prepare(`INSERT INTO local_message_inbox (
      message_id, client_id, type, status, idempotency_key, payload_json, received_at
    ) VALUES ('msg-task-update', 'edge-test', 'work.task.mutation.requested', 'pending', 'idem-task-update', ?, 1)`)
      .run(JSON.stringify({ operation: 'update', local_task_id: Number(created.lastInsertRowid), workspace_id: 1, expected_updated_at: 100, changes: { title: 'After', status: 'in_progress', tags: ['cloud'] }, actor: 'operator' }))

    expect(await processInbox(db)).toEqual({ executed: 1, failed: 0 })
    expect(db.prepare(`SELECT title, status, tags FROM tasks WHERE id = ?`).get(created.lastInsertRowid)).toEqual({
      title: 'After', status: 'in_progress', tags: '["cloud"]',
    })
    expect(db.prepare(`SELECT action FROM local_message_outbox WHERE message_id = 'msg-task-update'`).get()).toEqual({ action: 'ack' })
    expect(db.prepare(`SELECT type, actor FROM activities WHERE entity_id = ? ORDER BY id DESC LIMIT 1`).get(created.lastInsertRowid)).toEqual({ type: 'task_updated', actor: 'operator' })
  })

  it('rejects stale task mutations without changing local data', async () => {
    const created = db.prepare(`INSERT INTO tasks (title, status, priority, created_by, created_at, updated_at, workspace_id)
      VALUES ('Current', 'assigned', 'medium', 'test', 100, 200, 1)`).run()
    db.prepare(`INSERT INTO local_message_inbox (
      message_id, client_id, type, status, idempotency_key, payload_json, received_at
    ) VALUES ('msg-task-stale', 'edge-test', 'work.task.mutation.requested', 'pending', 'idem-task-stale', ?, 1)`)
      .run(JSON.stringify({ operation: 'update', local_task_id: Number(created.lastInsertRowid), workspace_id: 1, expected_updated_at: 100, changes: { title: 'Stale' } }))

    expect(await processInbox(db)).toEqual({ executed: 0, failed: 1 })
    expect(db.prepare(`SELECT title FROM tasks WHERE id = ?`).get(created.lastInsertRowid)).toEqual({ title: 'Current' })
    const outbox = db.prepare(`SELECT action, payload_json FROM local_message_outbox WHERE message_id = 'msg-task-stale'`).get() as { action: string; payload_json: string }
    expect(outbox.action).toBe('fail')
    expect(JSON.parse(outbox.payload_json)).toMatchObject({ error_code: 'TASK_VERSION_CONFLICT', retryable: false })
  })

  it('deletes a matching local task only after version validation', async () => {
    const created = db.prepare(`INSERT INTO tasks (title, status, priority, created_by, created_at, updated_at, workspace_id)
      VALUES ('Delete me', 'assigned', 'medium', 'test', 100, 100, 1)`).run()
    db.prepare(`INSERT INTO local_message_inbox (
      message_id, client_id, type, status, idempotency_key, payload_json, received_at
    ) VALUES ('msg-task-delete', 'edge-test', 'work.task.mutation.requested', 'pending', 'idem-task-delete', ?, 1)`)
      .run(JSON.stringify({ operation: 'delete', local_task_id: Number(created.lastInsertRowid), workspace_id: 1, expected_updated_at: 100, actor: 'operator' }))

    expect(await processInbox(db)).toEqual({ executed: 1, failed: 0 })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE id = ?`).get(created.lastInsertRowid)).toEqual({ count: 0 })
    expect(db.prepare(`SELECT type FROM activities WHERE entity_id = ? ORDER BY id DESC LIMIT 1`).get(created.lastInsertRowid)).toEqual({ type: 'task_deleted' })
  })
})
