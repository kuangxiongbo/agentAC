import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'

const fetchTranscript = vi.fn()
const sendContinue = vi.fn()
const fetchAgentDetail = vi.fn()
const runJudge = vi.fn()

const dbRef = vi.hoisted(() => ({ current: null as Database.Database | null }))

vi.mock('@/lib/db', () => ({
  getDatabase: () => dbRef.current,
}))

describe.sequential('human-watch-orchestrator', () => {
  let db: Database.Database

  beforeEach(async () => {
    const g = globalThis as typeof globalThis & {
      __humanWatchOrchestrator?: { stewardConfigCache: Map<string, unknown>; lastSweepAt: Map<number, number>; inFlight: Set<string> }
    }
    if (g.__humanWatchOrchestrator) {
      g.__humanWatchOrchestrator.stewardConfigCache.clear()
      g.__humanWatchOrchestrator.lastSweepAt.clear()
      g.__humanWatchOrchestrator.inFlight.clear()
    }
    db = new Database(':memory:')
    dbRef.current = db
    runMigrations(db)
    const { setHumanWatchEnabledForTenant } = await import('@/lib/human-watch-policy')
    setHumanWatchEnabledForTenant(1, true, db)
    db.prepare(
      `INSERT INTO human_watch_bindings (
        id, workspace_id, tenant_id, client_id,
        worker_local_agent_id, worker_name,
        steward_local_agent_id, steward_name,
        worker_session_id, enabled, mode, rules_override
      ) VALUES (1, 1, 1, 'mac-1', 10, 'worker', 9, 'steward', 'sess-worker-1', 1, 'auto_send', '{"grace_after_prompt_seconds":0}')`,
    ).run()
    db.prepare(
      `INSERT INTO sync_agent_index (
        id, client_id, client_name, local_agent_id, original_name, remote_name,
        role, status, framework, parent_local_id, updated_at
      ) VALUES (100, 'mac-1', 'Mac', 10, 'worker', 'mac-1-worker', 'agent', 'idle', 'claude', NULL, 1)`,
    ).run()
    fetchTranscript.mockReset()
    sendContinue.mockReset()
    fetchAgentDetail.mockReset()
    runJudge.mockReset()
    fetchAgentDetail.mockResolvedValue({ agent: null, source: 'test' })
    runJudge.mockResolvedValue({ reply: 'Please continue.', sessionId: 'judge-sess', source: 'test' })
  })

  const defaultDeps = () => ({
    isBridgeOnline: () => true,
    fetchTranscript,
    sendContinue,
    fetchAgentDetail,
    runJudge,
  })

  afterEach(() => {
    db.close()
    dbRef.current = null
  })

  it('logs rule_evaluated noop when rules do not match', async () => {
    const { evaluateHumanWatchBinding } = await import('@/lib/human-watch-orchestrator')
    fetchTranscript.mockResolvedValue({
      messages: [{ role: 'assistant', parts: [{ type: 'text', text: 'All done.' }], timestamp: new Date().toISOString() }],
    })
    sendContinue.mockResolvedValue({ accepted: true })

    await evaluateHumanWatchBinding(
      db.prepare(`SELECT * FROM human_watch_bindings WHERE id = 1`).get() as any,
      { sessionId: 'sess-worker-1', sessionKind: 'claude-code' },
      defaultDeps(),
    )

    const rows = db
      .prepare(`SELECT event_type, decision FROM human_watch_interventions ORDER BY id`)
      .all() as Array<{ event_type: string; decision: string | null }>
    expect(rows.some((r) => r.event_type === 'rule_evaluated' && r.decision === 'noop')).toBe(true)
    expect(sendContinue).not.toHaveBeenCalled()
  })

  it('auto-sends and logs attempt + completed on rule match', async () => {
    const { evaluateHumanWatchBinding } = await import('@/lib/human-watch-orchestrator')
    const stale = new Date(Date.now() - 120_000).toISOString()
    fetchTranscript.mockResolvedValue({
      messages: [
        {
          role: 'assistant',
          parts: [{ type: 'text', text: 'Please confirm which option you prefer.' }],
          timestamp: stale,
        },
      ],
    })
    sendContinue.mockResolvedValue({ accepted: true })

    await evaluateHumanWatchBinding(
      db.prepare(`SELECT * FROM human_watch_bindings WHERE id = 1`).get() as any,
      { sessionId: 'sess-worker-1', sessionKind: 'claude-code' },
      defaultDeps(),
    )

    expect(sendContinue).toHaveBeenCalled()
    const types = db
      .prepare(`SELECT event_type, outcome FROM human_watch_interventions ORDER BY id`)
      .all() as Array<{ event_type: string; outcome: string | null }>
    expect(types.some((r) => r.event_type === 'intervention_attempt')).toBe(true)
    expect(types.some((r) => r.event_type === 'intervention_completed' && r.outcome === 'success')).toBe(true)
  })

  it('logs bridge_offline skip', async () => {
    const { evaluateHumanWatchBinding } = await import('@/lib/human-watch-orchestrator')
    await evaluateHumanWatchBinding(
      db.prepare(`SELECT * FROM human_watch_bindings WHERE id = 1`).get() as any,
      { sessionId: 'sess-worker-1' },
      {
        ...defaultDeps(),
        isBridgeOnline: () => false,
      },
    )
    const row = db
      .prepare(
        `SELECT event_type, skip_reason FROM human_watch_interventions WHERE skip_reason = 'bridge_offline'`,
      )
      .get() as { event_type: string; skip_reason: string }
    expect(row.event_type).toBe('intervention_skipped')
    expect(row.skip_reason).toBe('bridge_offline')
    expect(sendContinue).not.toHaveBeenCalled()
  })

  it('logs failed continue with outcome failed', async () => {
    const { evaluateHumanWatchBinding } = await import('@/lib/human-watch-orchestrator')
    const stale = new Date(Date.now() - 120_000).toISOString()
    fetchTranscript.mockResolvedValue({
      messages: [
        {
          role: 'assistant',
          parts: [{ type: 'text', text: 'Please confirm which option you prefer.' }],
          timestamp: stale,
        },
      ],
    })
    sendContinue.mockRejectedValue(new Error('bridge timeout'))

    await evaluateHumanWatchBinding(
      db.prepare(`SELECT * FROM human_watch_bindings WHERE id = 1`).get() as any,
      { sessionId: 'sess-worker-1', sessionKind: 'claude-code' },
      defaultDeps(),
    )

    const failed = db
      .prepare(
        `SELECT outcome, error_message FROM human_watch_interventions
         WHERE event_type = 'intervention_completed'`,
      )
      .get() as { outcome: string; error_message: string }
    expect(failed.outcome).toBe('failed')
    expect(failed.error_message).toContain('bridge timeout')
  })

  it('skips duplicate fingerprint with intervention_skipped', async () => {
    const { evaluateHumanWatchBinding } = await import('@/lib/human-watch-orchestrator')
    const stale = new Date(Date.now() - 120_000).toISOString()
    fetchTranscript.mockResolvedValue({
      messages: [
        {
          role: 'assistant',
          parts: [{ type: 'text', text: 'Please confirm which option you prefer.' }],
          timestamp: stale,
        },
      ],
    })
    sendContinue.mockResolvedValue({ accepted: true })

    const binding = db.prepare(`SELECT * FROM human_watch_bindings WHERE id = 1`).get() as any
    const deps = defaultDeps()

    await evaluateHumanWatchBinding(binding, { sessionId: 'sess-worker-1', sessionKind: 'claude-code' }, deps)
    await evaluateHumanWatchBinding(binding, { sessionId: 'sess-worker-1', sessionKind: 'claude-code' }, deps)

    const skipped = db
      .prepare(
        `SELECT COUNT(*) as c FROM human_watch_interventions
         WHERE event_type = 'intervention_skipped' AND skip_reason = 'fingerprint_duplicate'`,
      )
      .get() as { c: number }
    expect(skipped.c).toBeGreaterThanOrEqual(1)
    expect(sendContinue).toHaveBeenCalledTimes(1)
  })

  it('logs llm_sweep when llmSweep option is set', async () => {
    const { evaluateHumanWatchBinding } = await import('@/lib/human-watch-orchestrator')
    fetchTranscript.mockResolvedValue({
      messages: [{ role: 'assistant', parts: [{ type: 'text', text: 'Done.' }], timestamp: new Date().toISOString() }],
    })

    await evaluateHumanWatchBinding(
      db.prepare(`SELECT * FROM human_watch_bindings WHERE id = 1`).get() as any,
      { sessionId: 'sess-worker-1', sessionKind: 'claude-code', llmSweep: true },
      defaultDeps(),
    )

    const sweep = db
      .prepare(`SELECT event_type, llm_sweep FROM human_watch_interventions WHERE event_type = 'llm_sweep'`)
      .get() as { event_type: string; llm_sweep: number }
    expect(sweep.event_type).toBe('llm_sweep')
    expect(sweep.llm_sweep).toBe(1)
  })

  it('uses steward judge reply when llm_enabled', async () => {
    const { evaluateHumanWatchBinding } = await import('@/lib/human-watch-orchestrator')
    const stale = new Date(Date.now() - 120_000).toISOString()
    fetchTranscript.mockResolvedValue({
      messages: [
        {
          role: 'assistant',
          parts: [{ type: 'text', text: 'Please confirm which option you prefer.' }],
          timestamp: stale,
        },
      ],
    })
    fetchAgentDetail.mockResolvedValue({
      agent: {
        config: JSON.stringify({ steward: { llm_enabled: true } }),
      },
      source: 'test',
    })
    runJudge.mockResolvedValue({ reply: 'Pick option A and continue.', sessionId: 'judge-1', source: 'test' })
    sendContinue.mockResolvedValue({ accepted: true })

    await evaluateHumanWatchBinding(
      db.prepare(`SELECT * FROM human_watch_bindings WHERE id = 1`).get() as any,
      { sessionId: 'sess-worker-1', sessionKind: 'claude-code' },
      defaultDeps(),
    )

    expect(runJudge).toHaveBeenCalled()
    expect(sendContinue).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Pick option A and continue.' }),
    )
  })
})
