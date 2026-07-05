import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'

const enqueueLocalSessionPrompt = vi.fn()

vi.mock('@/lib/local-session-executor', () => ({
  enqueueLocalSessionPrompt,
  isLocalSessionKind: (kind: string) => ['claude-code', 'codex-cli', 'hermes'].includes(kind),
}))

vi.mock('@/lib/human-watch-judge', () => ({
  runStewardJudgeOnEdge: vi.fn(),
}))

vi.mock('@/lib/session-transcript', () => ({
  readLocalSessionTranscriptPage: vi.fn(),
}))

describe('local-mailbox session continue handler', () => {
  let db: Database.Database

  beforeEach(() => {
    enqueueLocalSessionPrompt.mockReset()
    db = new Database(':memory:')
    runMigrations(db)
    db.prepare(`INSERT OR REPLACE INTO settings (key, value, category) VALUES ('device.client_id', 'edge-test', 'device')`).run()
  })

  afterEach(() => {
    db.close()
  })

  function insertContinueMessage(messageId: string) {
    db.prepare(`
      INSERT INTO local_message_inbox (
        message_id, client_id, type, status, idempotency_key,
        serial_key, payload_json, lease_owner, lease_expires_at, received_at
      ) VALUES (?, 'edge-test', 'session.continue.requested', 'pending', 'idem-session-continue',
        'edge-test:codex-cli:sess-1', ?, 'lease-1', 9999999999, 1)
    `).run(messageId, JSON.stringify({
      session_id: 'sess-1',
      session_kind: 'codex-cli',
      content: 'continue once',
    }))
  }

  it('does not enqueue duplicate session continue messages into Worker', async () => {
    const { processInbox } = await import('@/lib/local-mailbox')

    insertContinueMessage('msg-continue-1')
    expect(await processInbox(db)).toEqual({ executed: 1, failed: 0 })
    expect(enqueueLocalSessionPrompt).toHaveBeenCalledTimes(1)
    expect(enqueueLocalSessionPrompt).toHaveBeenLastCalledWith(
      'codex-cli',
      'sess-1',
      'continue once',
      expect.objectContaining({ workerSessionId: 'sess-1', sessionKind: 'codex-cli' }),
    )

    insertContinueMessage('msg-continue-2')
    expect(await processInbox(db)).toEqual({ executed: 1, failed: 0 })
    expect(enqueueLocalSessionPrompt).toHaveBeenCalledTimes(1)

    const duplicateAck = db.prepare(`
      SELECT payload_json FROM local_message_outbox
      WHERE message_id = 'msg-continue-2' AND action = 'ack'
    `).get() as { payload_json: string }
    expect(JSON.parse(duplicateAck.payload_json).duplicate).toBe(true)
  })
})
