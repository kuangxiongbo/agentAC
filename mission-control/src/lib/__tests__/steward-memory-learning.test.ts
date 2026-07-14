import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'
import { createSupervisionGoal } from '@/lib/supervision-goals'
import { extractStewardMemoryCandidates } from '@/lib/steward-memory-learning'
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
    const duplicate = await extractStewardMemoryCandidates({ goalId: 'goal-memory-1', workspaceId: 1 }, { runJudge }, db)
    expect(duplicate).toEqual({ memories: [], duplicate: true })
    expect(runJudge).toHaveBeenCalledOnce()
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
})
