import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'

const executeLocalSessionPromptAndWait = vi.fn()
const runStewardJudgeOnEdge = vi.fn()
const readLocalSessionTranscriptPage = vi.fn()

vi.mock('@/lib/local-session-executor', () => ({
  executeLocalSessionPromptAndWait,
  isLocalSessionKind: (kind: string) => ['claude-code', 'codex-cli', 'hermes'].includes(kind),
}))

vi.mock('@/lib/human-watch-judge', () => ({
  runStewardJudgeOnEdge,
}))

vi.mock('@/lib/session-transcript', () => ({
  readLocalSessionTranscriptPage,
}))

describe('local-mailbox human-watch assist handler', () => {
  let db: Database.Database

  beforeEach(() => {
    executeLocalSessionPromptAndWait.mockReset()
    executeLocalSessionPromptAndWait.mockResolvedValue({ sessionId: 'worker-session-1', reply: '正在继续执行。' })
    runStewardJudgeOnEdge.mockReset()
    readLocalSessionTranscriptPage.mockReset()
    db = new Database(':memory:')
    runMigrations(db)
    db.prepare(`INSERT OR REPLACE INTO settings (key, value, category) VALUES ('device.client_id', 'edge-test', 'device')`).run()
  })

  afterEach(() => {
    db.close()
  })

  it('runs the steward judge and writes the reply back into the Worker session', async () => {
    readLocalSessionTranscriptPage.mockReturnValue({
      messages: [
        {
          role: 'assistant',
          parts: [{ type: 'text', text: '我已经完成检查，需要确认下一步。' }],
        },
      ],
    })
    runStewardJudgeOnEdge.mockResolvedValue({
      reply: '继续执行下一步，并在完成后报告结果。',
      sessionId: 'steward-session-1',
    })

    db.prepare(`
      INSERT INTO local_message_inbox (
        message_id, client_id, type, status, idempotency_key,
        serial_key, payload_json, lease_owner, lease_expires_at, received_at
      ) VALUES (
        'msg-assist-1',
        'edge-test',
        'human_watch.assist.requested',
        'pending',
        'idem-assist-1',
        'edge-test:codex-cli:worker-session-1',
        ?,
        'lease-1',
        9999999999,
        1
      )
    `).run(JSON.stringify({
      binding_id: 1,
      client_id: 'edge-test',
      worker_local_agent_id: 11,
      worker_name: 'Worker',
      worker_session_id: 'worker-session-1',
      session_kind: 'codex-cli',
      steward_local_agent_id: 22,
      steward_name: '值守 Agent',
      prompt: 'Worker 回复后需要继续确认，请值守智能体给出下一句。',
      source: 'worker_mcp',
    }))

    const { processInbox } = await import('@/lib/local-mailbox')
    expect(await processInbox(db)).toEqual({ executed: 1, failed: 0 })

    expect(readLocalSessionTranscriptPage).toHaveBeenCalledWith('codex-cli', 'worker-session-1', { limit: 24 })
    expect(runStewardJudgeOnEdge).toHaveBeenCalledWith(
      22,
      expect.stringContaining('Worker 主动求助'),
    )
    expect(executeLocalSessionPromptAndWait).toHaveBeenCalledWith(
      'codex-cli',
      'worker-session-1',
      '继续执行下一步，并在完成后报告结果。',
      expect.objectContaining({
        workerSessionId: 'worker-session-1',
        sessionKind: 'codex-cli',
      }),
    )

    const inbox = db.prepare(`SELECT status, result_json FROM local_message_inbox WHERE message_id = 'msg-assist-1'`)
      .get() as { status: string; result_json: string }
    expect(inbox.status).toBe('completed')
    expect(JSON.parse(inbox.result_json)).toMatchObject({
      delivered: true,
      steward_reply: '继续执行下一步，并在完成后报告结果。',
      steward_session_id: 'steward-session-1',
      worker_reply: '正在继续执行。',
    })

    const outbox = db.prepare(`SELECT action, payload_json FROM local_message_outbox WHERE message_id = 'msg-assist-1'`)
      .get() as { action: string; payload_json: string }
    expect(outbox.action).toBe('ack')
    expect(JSON.parse(outbox.payload_json).result.delivered).toBe(true)
  })

  it('reports failure when the steward reply cannot be executed by the Worker', async () => {
    readLocalSessionTranscriptPage.mockReturnValue({ messages: [] })
    runStewardJudgeOnEdge.mockResolvedValue({ reply: '继续执行。', sessionId: 'steward-session-1' })
    executeLocalSessionPromptAndWait.mockRejectedValueOnce(new Error('worker session unavailable'))
    db.prepare(`
      INSERT INTO local_message_inbox (
        message_id, client_id, type, status, idempotency_key,
        serial_key, payload_json, lease_owner, lease_expires_at, received_at
      ) VALUES ('msg-assist-failed', 'edge-test', 'human_watch.assist.requested', 'pending',
        'idem-assist-failed', 'edge-test:codex-cli:worker-session-1', ?, 'lease-1', 9999999999, 1)
    `).run(JSON.stringify({
      worker_session_id: 'worker-session-1',
      session_kind: 'codex-cli',
      steward_local_agent_id: 22,
      prompt: '请继续',
    }))

    const { processInbox } = await import('@/lib/local-mailbox')
    expect(await processInbox(db)).toEqual({ executed: 0, failed: 1 })
    expect(db.prepare(`SELECT status, last_error FROM local_message_inbox WHERE message_id = ?`)
      .get('msg-assist-failed')).toEqual({ status: 'failed', last_error: 'worker session unavailable' })
  })
})
