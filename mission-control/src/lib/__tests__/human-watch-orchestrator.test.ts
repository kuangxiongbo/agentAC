import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'

const fetchTranscript = vi.fn()
const sendContinue = vi.fn()
const fetchAgentDetail = vi.fn()
const runJudge = vi.fn()
const fetchMemoryContext = vi.fn()

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
    const { setHumanWatchGlobalRules } = await import('@/lib/human-watch-global-rules')
    const tenant = db.prepare(`SELECT id FROM tenants LIMIT 1`).get() as { id: number }
    setHumanWatchEnabledForTenant(tenant.id, true, db)
    setHumanWatchGlobalRules(tenant.id, { grace_after_prompt_seconds: 0 }, db)
    db.prepare(
      `INSERT INTO human_watch_bindings (
        id, workspace_id, tenant_id, client_id,
        worker_local_agent_id, worker_name,
        steward_local_agent_id, steward_name,
        worker_session_id, enabled, mode, rules_override
      ) VALUES (1, 1, ${tenant.id}, 'mac-1', 10, 'worker', 9, 'steward', 'sess-worker-1', 1, 'auto_send', NULL)`,
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
    fetchMemoryContext.mockReset()
    fetchAgentDetail.mockResolvedValue({
      agent: {
        role: 'human-watch',
        config: JSON.stringify({ agent_kind: 'human_watch', steward: { llm_enabled: true } }),
      },
      source: 'test',
    })
    runJudge.mockResolvedValue({ reply: 'Please continue with option A.', sessionId: 'judge-sess', source: 'test' })
  })

  const defaultDeps = () => ({
    isBridgeOnline: () => true,
    fetchTranscript,
    sendContinue,
    fetchAgentDetail,
    runJudge,
    fetchMemoryContext,
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
    const event = db
      .prepare(`SELECT status, resolved_action, resolved_by_type, resolved_note FROM human_watch_events ORDER BY created_at DESC LIMIT 1`)
      .get() as { status: string; resolved_action: string | null; resolved_by_type: string | null; resolved_note: string | null }
    expect(event.status).toBe('resolved')
    expect(event.resolved_action).toBe('send_message_to_worker')
    expect(event.resolved_by_type).toBe('steward_agent')
    expect(event.resolved_note).toBe('Please continue with option A.')
  })

  it('records mailbox identity and waits for ACK before completing', async () => {
    const { evaluateHumanWatchBinding } = await import('@/lib/human-watch-orchestrator')
    const stale = new Date(Date.now() - 120_000).toISOString()
    fetchTranscript.mockResolvedValue({
      messages: [{
        role: 'assistant',
        parts: [{ type: 'text', text: '请选择蓝色或绿色主题，然后确认。' }],
        timestamp: stale,
      }],
    })
    sendContinue.mockResolvedValue({
      messageId: 'hw-message-1',
      correlationId: 'human-watch:1:sess-worker-1:fingerprint',
      duplicate: false,
    })

    await evaluateHumanWatchBinding(
      db.prepare(`SELECT * FROM human_watch_bindings WHERE id = 1`).get() as any,
      { sessionId: 'sess-worker-1', sessionKind: 'claude-code' },
      defaultDeps(),
    )

    const rows = db.prepare(`
      SELECT event_type, outcome, message_id, correlation_id
      FROM human_watch_interventions ORDER BY id
    `).all() as Array<{ event_type: string; outcome: string | null; message_id: string | null; correlation_id: string | null }>
    const attempt = rows.find((row) => row.event_type === 'intervention_attempt')
    expect(attempt).toMatchObject({
      message_id: 'hw-message-1',
      correlation_id: 'human-watch:1:sess-worker-1:fingerprint',
    })
    expect(rows.some((row) => row.event_type === 'intervention_completed')).toBe(false)
    const event = db.prepare(`SELECT status, context_json FROM human_watch_events ORDER BY created_at DESC LIMIT 1`)
      .get() as { status: string; context_json: string }
    expect(event.status).toBe('pending')
    expect(JSON.parse(event.context_json)).toMatchObject({
      message_id: 'hw-message-1',
      delivery_status: 'queued',
    })
  })

  it('uses steward judge for explicit answer-then-confirm prompts', async () => {
    const { evaluateHumanWatchBinding } = await import('@/lib/human-watch-orchestrator')
    const stale = new Date(Date.now() - 6_000).toISOString()
    fetchTranscript.mockResolvedValue({
      messages: [
        {
          role: 'assistant',
          parts: [{ type: 'text', text: '请回答这个问题，回答后说"确认"。' }],
          timestamp: stale,
        },
      ],
    })
    sendContinue.mockResolvedValue({ accepted: true })
    runJudge.mockResolvedValue({ reply: '我会优先处理重复排查日志的脚本。确认。', sessionId: 'judge-sess', source: 'test' })

    await evaluateHumanWatchBinding(
      db.prepare(`SELECT * FROM human_watch_bindings WHERE id = 1`).get() as any,
      { sessionId: 'sess-worker-1', sessionKind: 'claude-code' },
      defaultDeps(),
    )

    expect(runJudge).toHaveBeenCalled()
    expect(sendContinue).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: '我会优先处理重复排查日志的脚本。确认。',
      }),
    )
  })

  it('auto-stops a binding after configured successful interventions', async () => {
    const { evaluateHumanWatchBinding } = await import('@/lib/human-watch-orchestrator')
    db.prepare(`UPDATE human_watch_bindings SET rules_override = ? WHERE id = 1`).run(
      JSON.stringify({
        auto_stop: {
          enabled: true,
          max_successful_interventions: 1,
        },
      }),
    )
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

    const binding = db.prepare(`SELECT enabled FROM human_watch_bindings WHERE id = 1`).get() as { enabled: number }
    expect(binding.enabled).toBe(0)
    const row = db
      .prepare(`SELECT event_type, decision, outcome, skip_reason FROM human_watch_interventions ORDER BY id DESC LIMIT 1`)
      .get() as { event_type: string; decision: string | null; outcome: string | null; skip_reason: string | null }
    expect(row.event_type).toBe('auto_stop')
    expect(row.decision).toBe('disabled')
    expect(row.outcome).toBe('success')
    expect(row.skip_reason).toBe('max_successful_interventions:1')
  })

  it('restarts the auto-stop runtime window when a binding is re-enabled', async () => {
    const { evaluateHumanWatchBinding } = await import('@/lib/human-watch-orchestrator')
    const now = Math.floor(Date.now() / 1000)
    db.prepare(`
      UPDATE human_watch_bindings
      SET created_at = ?, updated_at = ?, rules_override = ?
      WHERE id = 1
    `).run(
      now - 86400,
      now,
      JSON.stringify({ auto_stop: { enabled: true, max_runtime_seconds: 60 } }),
    )
    fetchTranscript.mockResolvedValue({
      messages: [{ role: 'assistant', parts: [{ type: 'text', text: 'All done.' }], timestamp: new Date().toISOString() }],
    })

    await evaluateHumanWatchBinding(
      db.prepare(`SELECT * FROM human_watch_bindings WHERE id = 1`).get() as any,
      { sessionId: 'sess-worker-1', sessionKind: 'claude-code' },
      defaultDeps(),
    )

    const binding = db.prepare(`SELECT enabled FROM human_watch_bindings WHERE id = 1`).get() as { enabled: number }
    expect(binding.enabled).toBe(1)
    expect(fetchTranscript).toHaveBeenCalledTimes(1)
    const autoStops = db.prepare(
      `SELECT COUNT(*) AS count FROM human_watch_interventions WHERE event_type = 'auto_stop'`,
    ).get() as { count: number }
    expect(autoStops.count).toBe(0)
  })

  it('auto-stops after the configured runtime expires', async () => {
    const { evaluateHumanWatchBinding } = await import('@/lib/human-watch-orchestrator')
    const now = Math.floor(Date.now() / 1000)
    db.prepare(`UPDATE human_watch_bindings SET created_at = ?, updated_at = ?, rules_override = ? WHERE id = 1`).run(
      now - 120,
      now - 120,
      JSON.stringify({ auto_stop: { enabled: true, max_runtime_seconds: 60 } }),
    )

    await evaluateHumanWatchBinding(
      db.prepare(`SELECT * FROM human_watch_bindings WHERE id = 1`).get() as any,
      { sessionId: 'sess-worker-1', sessionKind: 'claude-code' },
      defaultDeps(),
    )

    expect(fetchTranscript).not.toHaveBeenCalled()
    expect(db.prepare(`SELECT enabled FROM human_watch_bindings WHERE id = 1`).get()).toMatchObject({ enabled: 0 })
    expect(db.prepare(`SELECT skip_reason FROM human_watch_interventions WHERE event_type = 'auto_stop'`).get())
      .toMatchObject({ skip_reason: 'max_runtime_seconds:60' })
  })

  it('enforces runtime auto-stop without reading an offline Edge transcript', async () => {
    const { enforceHumanWatchAutoStops } = await import('@/lib/human-watch-orchestrator')
    const now = Math.floor(Date.now() / 1000)
    db.prepare(`UPDATE human_watch_bindings SET created_at = ?, updated_at = ?, rules_override = ? WHERE id = 1`).run(
      now - 120,
      now - 120,
      JSON.stringify({ auto_stop: { enabled: true, max_runtime_seconds: 60 } }),
    )

    expect(enforceHumanWatchAutoStops()).toBe(1)
    expect(fetchTranscript).not.toHaveBeenCalled()
    expect(runJudge).not.toHaveBeenCalled()
    expect(db.prepare(`SELECT enabled FROM human_watch_bindings WHERE id = 1`).get()).toMatchObject({ enabled: 0 })
    expect(db.prepare(`SELECT skip_reason FROM human_watch_interventions WHERE event_type = 'auto_stop'`).get())
      .toMatchObject({ skip_reason: 'max_runtime_seconds:60' })
  })

  it('auto-stops after configured rate-limit skips', async () => {
    const { logHumanWatchIntervention } = await import('@/lib/human-watch-audit')
    const { evaluateHumanWatchBinding } = await import('@/lib/human-watch-orchestrator')
    db.prepare(`UPDATE human_watch_bindings SET rules_override = ? WHERE id = 1`).run(
      JSON.stringify({ auto_stop: { enabled: true, max_rate_limited_skips: 2 } }),
    )
    for (let index = 0; index < 2; index += 1) {
      logHumanWatchIntervention({
        workspaceId: 1,
        clientId: 'mac-1',
        bindingId: 1,
        eventType: 'intervention_skipped',
        decision: 'skipped',
        skipReason: 'rate_limited',
      })
    }

    await evaluateHumanWatchBinding(
      db.prepare(`SELECT * FROM human_watch_bindings WHERE id = 1`).get() as any,
      { sessionId: 'sess-worker-1', sessionKind: 'claude-code' },
      defaultDeps(),
    )

    expect(fetchTranscript).not.toHaveBeenCalled()
    expect(db.prepare(`SELECT enabled FROM human_watch_bindings WHERE id = 1`).get()).toMatchObject({ enabled: 0 })
    expect(db.prepare(`SELECT skip_reason FROM human_watch_interventions WHERE event_type = 'auto_stop'`).get())
      .toMatchObject({ skip_reason: 'max_rate_limited_skips:2' })
  })

  it('falls back to synced session kind when worker agent index is missing', async () => {
    const { evaluateHumanWatchBinding } = await import('@/lib/human-watch-orchestrator')
    db.prepare(`DELETE FROM sync_agent_index WHERE client_id = 'mac-1' AND local_agent_id = 10`).run()
    db.prepare(`
      INSERT INTO sync_sessions (
        client_id, client_name, session_id, session_key, session_kind,
        runtime_group, agent, active, created_at, updated_at
      ) VALUES (
        'mac-1', 'Mac', 'sess-worker-1', 'worker-key', 'claude-code',
        'claude', 'worker', 1, unixepoch(), unixepoch()
      )
    `).run()
    const stale = new Date(Date.now() - 120_000).toISOString()
    fetchTranscript.mockResolvedValue({
      messages: [
        {
          role: 'assistant',
          parts: [{ type: 'text', text: '需要你确认是否继续执行下一步，请回复继续或停止。' }],
          timestamp: stale,
        },
      ],
    })
    sendContinue.mockResolvedValue({ accepted: true })

    await evaluateHumanWatchBinding(
      db.prepare(`SELECT * FROM human_watch_bindings WHERE id = 1`).get() as any,
      {},
      defaultDeps(),
    )

    expect(fetchTranscript).toHaveBeenCalledWith(expect.objectContaining({ kind: 'claude-code' }))
    expect(sendContinue).toHaveBeenCalledWith(expect.objectContaining({ kind: 'claude-code' }))
    const skipped = db
      .prepare(`SELECT COUNT(*) as count FROM human_watch_interventions WHERE skip_reason = 'no_session_kind'`)
      .get() as { count: number }
    expect(skipped.count).toBe(0)
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
    const activeEvents = db
      .prepare(`SELECT COUNT(*) as c FROM human_watch_events WHERE status IN ('pending', 'visible', 'claimed')`)
      .get() as { c: number }
    expect(activeEvents.c).toBe(0)
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

  it('always uses steward judge reply for auto_send', async () => {
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
    runJudge.mockResolvedValue({ reply: 'Pick option A and continue.', sessionId: 'judge-1', source: 'test' })
    sendContinue.mockResolvedValue({ accepted: true })

    await evaluateHumanWatchBinding(
      db.prepare(`SELECT * FROM human_watch_bindings WHERE id = 1`).get() as any,
      { sessionId: 'sess-worker-1', sessionKind: 'claude-code' },
      defaultDeps(),
    )

    expect(runJudge).toHaveBeenCalled()
    expect(runJudge).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Worker 上下文：'),
      }),
    )
    expect(runJudge).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Worker 会话摘录：'),
      }),
    )
    expect(sendContinue).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Pick option A and continue.' }),
    )
  })

  it('persists structured worker context into created watch event', async () => {
    const { evaluateHumanWatchBinding } = await import('@/lib/human-watch-orchestrator')
    const stale = new Date(Date.now() - 120_000).toISOString()
    fetchTranscript.mockResolvedValue({
      messages: [
        {
          role: 'user',
          parts: [{ type: 'text', text: '请继续处理端口冲突' }],
          timestamp: stale,
        },
        {
          role: 'assistant',
          parts: [{ type: 'text', text: '我当前受阻，请确认是否继续 kill 旧进程。' }],
          timestamp: stale,
        },
      ],
    })
    runJudge.mockResolvedValue({ reply: '继续 kill 旧进程，然后重新启动。', sessionId: 'judge-2', source: 'test' })
    sendContinue.mockResolvedValue({ accepted: true })

    await evaluateHumanWatchBinding(
      db.prepare(`SELECT * FROM human_watch_bindings WHERE id = 1`).get() as any,
      { sessionId: 'sess-worker-1', sessionKind: 'claude-code' },
      defaultDeps(),
    )

    const event = db
      .prepare(`SELECT context_json FROM human_watch_events ORDER BY id DESC LIMIT 1`)
      .get() as { context_json: string | null }
    const context = event?.context_json ? JSON.parse(event.context_json) as Record<string, unknown> : {}
    expect(String(context.worker_judge_context || '')).toContain('最近用户意图')
    expect(String(context.worker_summary || '')).toContain('ASSISTANT:')
  })

  it('adds retrieved memory context to steward judge prompt and event context', async () => {
    const { evaluateHumanWatchBinding } = await import('@/lib/human-watch-orchestrator')
    const stale = new Date(Date.now() - 120_000).toISOString()
    fetchTranscript.mockResolvedValue({
      messages: [
        {
          role: 'user',
          parts: [{ type: 'text', text: '是否继续部署生产？' }],
          timestamp: stale,
        },
        {
          role: 'assistant',
          parts: [{ type: 'text', text: '请确认是否继续部署生产。' }],
          timestamp: stale,
        },
      ],
    })
    fetchMemoryContext.mockResolvedValue('1. 发布 SOP: 小范围验证后才继续部署。')
    runJudge.mockResolvedValue({ reply: '继续，但先做小范围验证。', sessionId: 'judge-memory', source: 'test' })
    sendContinue.mockResolvedValue({ accepted: true })

    await evaluateHumanWatchBinding(
      db.prepare(`SELECT * FROM human_watch_bindings WHERE id = 1`).get() as any,
      { sessionId: 'sess-worker-1', sessionKind: 'claude-code' },
      defaultDeps(),
    )

    expect(fetchMemoryContext).toHaveBeenCalled()
    expect(runJudge).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('值守记忆检索'),
      }),
    )
    expect(runJudge).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('发布 SOP'),
      }),
    )
    const event = db
      .prepare(`SELECT context_json FROM human_watch_events ORDER BY id DESC LIMIT 1`)
      .get() as { context_json: string | null }
    const context = event?.context_json ? JSON.parse(event.context_json) as Record<string, unknown> : {}
    expect(String(context.steward_memory_context || '')).toContain('发布 SOP')
  })

  it('skips send when steward judge returns empty reply', async () => {
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
    runJudge.mockResolvedValue({ reply: '', sessionId: 'judge-1', source: 'test' })

    await evaluateHumanWatchBinding(
      db.prepare(`SELECT * FROM human_watch_bindings WHERE id = 1`).get() as any,
      { sessionId: 'sess-worker-1', sessionKind: 'claude-code' },
      defaultDeps(),
    )

    expect(sendContinue).not.toHaveBeenCalled()
    const skipped = db
      .prepare(
        `SELECT skip_reason FROM human_watch_interventions
         WHERE event_type = 'intervention_skipped' AND skip_reason = 'steward_judge_empty'`,
      )
      .get() as { skip_reason: string }
    expect(skipped.skip_reason).toBe('steward_judge_empty')
  })

  it('auto-sends semantic confirmation, choice, and supplemental replies', async () => {
    const { evaluateHumanWatchBinding } = await import('@/lib/human-watch-orchestrator')
    const cases = [
      ['请确认是否继续生成报告。', '确认继续生成报告。'],
      ['请选择 PDF 或 DOCX。', '选择 PDF，确认。'],
      ['请补充交付日期，回复后说确认。', '交付日期为 2026-08-01，请继续。'],
    ]
    for (const [question, reply] of cases) {
      fetchTranscript.mockResolvedValue({ messages: [{ role: 'assistant', parts: [{ type: 'text', text: question }], timestamp: new Date(Date.now() - 120_000).toISOString() }] })
      runJudge.mockResolvedValue({ reply: JSON.stringify({ action: 'reply', reply, reason: '上下文足够', risk: 'normal' }) })
      sendContinue.mockResolvedValue({ accepted: true })
      await evaluateHumanWatchBinding(
        db.prepare(`SELECT * FROM human_watch_bindings WHERE id = 1`).get() as any,
        { sessionId: 'sess-worker-1', sessionKind: 'claude-code' },
        defaultDeps(),
      )
    }
    expect(sendContinue.mock.calls.map(([input]) => input.prompt)).toEqual(cases.map((entry) => entry[1]))
  })

  it('keeps dangerous actions visible for a human and never sends them', async () => {
    const { evaluateHumanWatchBinding } = await import('@/lib/human-watch-orchestrator')
    fetchTranscript.mockResolvedValue({ messages: [{ role: 'assistant', parts: [{ type: 'text', text: '请确认是否删除生产数据库。' }], timestamp: new Date(Date.now() - 120_000).toISOString() }] })
    runJudge.mockResolvedValue({ reply: JSON.stringify({ action: 'reply', reply: '确认删除。', reason: '请求确认', risk: 'normal' }) })

    await evaluateHumanWatchBinding(
      db.prepare(`SELECT * FROM human_watch_bindings WHERE id = 1`).get() as any,
      { sessionId: 'sess-worker-1', sessionKind: 'claude-code' },
      defaultDeps(),
    )

    expect(sendContinue).not.toHaveBeenCalled()
    const event = db.prepare(`SELECT status, priority, context_json FROM human_watch_events LIMIT 1`).get() as any
    expect(event.status).toBe('visible')
    expect(event.priority).toBe('high')
    expect(JSON.parse(event.context_json).escalation_reason).toContain('安全策略')
    expect(db.prepare(`SELECT skip_reason FROM human_watch_interventions WHERE event_type = 'intervention_skipped'`).get())
      .toMatchObject({ skip_reason: 'dangerous_action_requires_human' })
  })

  it('keeps insufficient-information decisions visible for a human', async () => {
    const { evaluateHumanWatchBinding } = await import('@/lib/human-watch-orchestrator')
    fetchTranscript.mockResolvedValue({ messages: [{ role: 'assistant', parts: [{ type: 'text', text: '请确认未指定的客户最终报价。' }], timestamp: new Date(Date.now() - 120_000).toISOString() }] })
    runJudge.mockResolvedValue({ reply: JSON.stringify({ action: 'escalate_human', reply: '', reason: '缺少只能由负责人决定的最终报价', risk: 'high' }) })

    await evaluateHumanWatchBinding(
      db.prepare(`SELECT * FROM human_watch_bindings WHERE id = 1`).get() as any,
      { sessionId: 'sess-worker-1', sessionKind: 'claude-code' },
      defaultDeps(),
    )

    expect(sendContinue).not.toHaveBeenCalled()
    const event = db.prepare(`SELECT status, context_json FROM human_watch_events LIMIT 1`).get() as any
    expect(event.status).toBe('visible')
    expect(JSON.parse(event.context_json).escalation_reason).toContain('最终报价')
  })

  it('does not rerun the judge while the same fingerprint has an active watch event', async () => {
    const { evaluateHumanWatchBinding } = await import('@/lib/human-watch-orchestrator')
    const messages = [{ role: 'assistant', parts: [{ type: 'text', text: '请确认是否删除生产数据库。' }], timestamp: new Date(Date.now() - 120_000).toISOString() }]
    fetchTranscript.mockResolvedValue({ messages })
    runJudge.mockResolvedValue({ reply: JSON.stringify({ action: 'escalate_human', reply: '', reason: '高风险操作', risk: 'critical' }) })
    const binding = db.prepare(`SELECT * FROM human_watch_bindings WHERE id = 1`).get() as any

    await evaluateHumanWatchBinding(binding, { sessionId: 'sess-worker-1', sessionKind: 'claude-code' }, defaultDeps())
    await evaluateHumanWatchBinding(binding, { sessionId: 'sess-worker-1', sessionKind: 'claude-code' }, defaultDeps())

    expect(runJudge).toHaveBeenCalledTimes(1)
    expect(sendContinue).not.toHaveBeenCalled()
    expect(db.prepare(`SELECT COUNT(*) AS count FROM human_watch_events`).get()).toMatchObject({ count: 1 })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM human_watch_interventions WHERE event_type = 'intervention_skipped'`).get())
      .toMatchObject({ count: 1 })
  })
})
