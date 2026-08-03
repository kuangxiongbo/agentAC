import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'
import { createSupervisionGoal } from '@/lib/supervision-goals'
import { extractStewardMemoryCandidates, runStewardMemoryLearning } from '@/lib/steward-memory-learning'
import { listStewardMemories } from '@/lib/steward-memories'

describe('steward memory learning', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    db.prepare(`
      INSERT INTO sync_agent_index (
        client_id, client_name, local_agent_id, original_name, remote_name,
        role, status, framework, session_key, updated_at
      ) VALUES ('edge-a', 'Mac', 7, 'Steward', 'edge-a-Steward',
        'human-watch', 'idle', 'codex', 'steward-session', unixepoch())
    `).run()
  })

  afterEach(() => db.close())

  function completedGoal(id: string) {
    createSupervisionGoal({
      id,
      workspaceId: 1,
      tenantId: 1,
      clientId: 'edge-a',
      stewardLocalAgentId: 7,
      title: `Release ${id}`,
      objective: 'Release after full tests',
      successCriteria: [{ id: 'tests', text: 'Tests pass' }],
      budget: {
        max_tasks: 2,
        max_parallel_workers: 1,
        max_retries_per_task: 1,
        max_replans: 1,
        max_runtime_seconds: 3600,
        max_model_calls: 2,
      },
      createdBy: '2',
    }, db)
    db.prepare(`UPDATE supervision_goals SET status = 'completed', completed_at = unixepoch() WHERE id = ?`).run(id)
  }

  const judgeReply = JSON.stringify({
    candidates: [
      {
        category: 'procedure',
        scope_type: 'user',
        scope_id: '2',
        content: 'Run the full test suite before publishing a release image.',
        summary: 'Release test procedure',
        confidence: 0.75,
        evidence_note: 'The completed release goal passed after full tests.',
      },
      {
        category: 'preference',
        scope_type: 'user',
        scope_id: '2',
        content: 'Prefer concise release reports.',
        confidence: 0.6,
        evidence_note: 'The user requested a concise report in this goal.',
      },
    ],
  })

  it('extracts candidates once per completed goal', async () => {
    completedGoal('goal-memory-1')
    const runJudge = vi.fn(async () => ({ reply: judgeReply, sessionId: 'steward-session', source: 'test' }))
    const first = await extractStewardMemoryCandidates({ goalId: 'goal-memory-1', workspaceId: 1 }, { runJudge }, db)
    expect(first).toMatchObject({ duplicate: false })
    expect(first.memories).toHaveLength(2)
    expect(first.memories.every((memory) => memory.status === 'candidate')).toBe(true)
    expect(first.memories.every((memory) => memory.expires_at === null)).toBe(true)
    const duplicate = await extractStewardMemoryCandidates({ goalId: 'goal-memory-1', workspaceId: 1 }, { runJudge }, db)
    expect(duplicate).toEqual({ memories: [], duplicate: true })
    expect(runJudge).toHaveBeenCalledOnce()
  })

  it('learns after completion even when execution runtime and model-call budgets are exhausted', async () => {
    completedGoal('goal-exhausted-execution')
    db.prepare(`
      UPDATE supervision_goals
      SET created_at = 1, usage_json = '{"model_calls":2,"estimated_cost":0}'
      WHERE id = 'goal-exhausted-execution'
    `).run()
    const runJudge = vi.fn(async () => ({ reply: judgeReply, sessionId: 'steward-session', source: 'test' }))
    const result = await extractStewardMemoryCandidates({
      goalId: 'goal-exhausted-execution',
      workspaceId: 1,
    }, { runJudge }, db)
    expect(result.memories).toHaveLength(2)
    expect(runJudge).toHaveBeenCalledOnce()
  })

  it('bounds completed-goal context to the Edge steward judge protocol limit', async () => {
    completedGoal('goal-large-context')
    db.prepare(`
      UPDATE supervision_goals
      SET objective = ?, constraints_json = ?, success_criteria_json = ?
      WHERE id = 'goal-large-context'
    `).run('O'.repeat(10_000), JSON.stringify(['C'.repeat(10_000)]), JSON.stringify([{ id: 'tests', text: 'S'.repeat(10_000) }]))
    for (let index = 0; index < 20; index++) {
      db.prepare(`
        INSERT INTO supervision_events (
          workspace_id, tenant_id, goal_id, event_type, actor_type, reason, evidence_json, action_json
        ) VALUES (1, 1, 'goal-large-context', 'test_event', 'system', ?, ?, ?)
      `).run('R'.repeat(2_000), JSON.stringify({ detail: 'E'.repeat(2_000) }), JSON.stringify({ detail: 'A'.repeat(2_000) }))
    }
    let capturedPrompt = ''
    const runJudge = vi.fn(async (input: { prompt: string }) => {
      capturedPrompt = input.prompt
      return { reply: judgeReply, sessionId: 'steward-session', source: 'test' }
    })

    const result = await extractStewardMemoryCandidates({ goalId: 'goal-large-context', workspaceId: 1 }, { runJudge }, db)

    expect(result.memories).toHaveLength(2)
    expect(capturedPrompt.length).toBeLessThanOrEqual(6000)
    expect(capturedPrompt).toContain('只输出 JSON')
    expect(capturedPrompt).toContain('goal-large-context')
    expect(capturedPrompt).toContain('[truncated]')
  })

  it('promotes a procedure after three independent successful goals but not a preference', async () => {
    const runJudge = vi.fn(async () => ({ reply: judgeReply, sessionId: 'steward-session', source: 'test' }))
    for (const id of ['goal-memory-1', 'goal-memory-2', 'goal-memory-3']) {
      completedGoal(id)
      await extractStewardMemoryCandidates({ goalId: id, workspaceId: 1 }, { runJudge }, db)
    }
    const memories = listStewardMemories({ workspaceId: 1, tenantId: 1 }, db).memories
    const procedure = memories.find((memory) => memory.category === 'procedure')!
    const preference = memories.find((memory) => memory.category === 'preference')!
    expect(procedure).toMatchObject({ status: 'approved' })
    expect(procedure.source_refs).toHaveLength(3)
    expect(procedure.evidence).toHaveLength(3)
    expect(preference.status).toBe('candidate')
  })

  it('rejects a scope id invented by the model', async () => {
    completedGoal('goal-invalid-scope')
    const runJudge = vi.fn(async () => ({
      reply: JSON.stringify({
        candidates: [{
          category: 'fact',
          scope_type: 'user',
          scope_id: 'another-user',
          content: 'Invented fact',
          confidence: 0.9,
          evidence_note: 'Invalid',
        }],
      }),
      sessionId: 'steward-session',
      source: 'test',
    }))
    await expect(extractStewardMemoryCandidates({
      goalId: 'goal-invalid-scope',
      workspaceId: 1,
    }, { runJudge }, db)).rejects.toThrow('MEMORY_SCOPE_ID_INVALID')
  })

  it('audits failures, cools down scheduled retries, and recovers later', async () => {
    completedGoal('goal-retry')
    let now = 1_800_000_000
    const runJudge = vi.fn()
      .mockRejectedValueOnce(new Error('EDGE_STEWARD_OFFLINE'))
      .mockResolvedValue({ reply: judgeReply, sessionId: 'steward-session', source: 'test' })

    const failed = await runStewardMemoryLearning({}, { runJudge, now: () => now }, db)
    expect(failed).toMatchObject({ processed: 0, candidates: 0, skipped_cooldown: 0, skipped_exhausted: 0 })
    expect(failed.errors[0]).toContain('EDGE_STEWARD_OFFLINE')
    const failureEvent = db.prepare(`
      SELECT event_type, reason, action_json FROM supervision_events
      WHERE goal_id = 'goal-retry' AND event_type = 'memory_candidates_extraction_failed'
    `).get() as { event_type: string; reason: string; action_json: string }
    expect(failureEvent.reason).toBe('EDGE_STEWARD_OFFLINE')
    expect(JSON.parse(failureEvent.action_json)).toMatchObject({ attempts: 1, retry_after: now + 900 })

    now += 60
    const cooled = await runStewardMemoryLearning({}, { runJudge, now: () => now }, db)
    expect(cooled).toMatchObject({ processed: 0, skipped_cooldown: 1, errors: [] })
    expect(runJudge).toHaveBeenCalledOnce()

    now += 900
    const recovered = await runStewardMemoryLearning({}, { runJudge, now: () => now }, db)
    expect(recovered).toMatchObject({ processed: 1, candidates: 2, skipped_cooldown: 0, skipped_exhausted: 0, errors: [] })
    expect(runJudge).toHaveBeenCalledTimes(2)
  })

  it('stops automatic retries after the scheduled attempt limit', async () => {
    completedGoal('goal-retry-limit')
    const runJudge = vi.fn(async () => { throw new Error('EDGE_STEWARD_OFFLINE') })
    let now = 1_800_000_000
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await runStewardMemoryLearning({ retryCooldownSeconds: 0 }, { runJudge, now: () => now++ }, db)
      expect(result.errors).toHaveLength(1)
    }
    const exhausted = await runStewardMemoryLearning({ retryCooldownSeconds: 0 }, { runJudge, now: () => now }, db)
    expect(exhausted).toMatchObject({ skipped_exhausted: 1, errors: [] })
    expect(runJudge).toHaveBeenCalledTimes(3)
  })
})
