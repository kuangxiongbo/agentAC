import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'
import { dispatchSupervisionGoal } from '@/lib/supervision-dispatcher'
import { createSupervisionGoal, getSupervisionGoal, listSupervisionGoalEvents } from '@/lib/supervision-goals'
import { saveSupervisionGoalPlan } from '@/lib/supervision-plans'
import { verifySupervisionGoal } from '@/lib/supervision-verifier'

describe('supervision verifier', () => {
  let db: Database.Database
  let taskId: number

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    const now = Math.floor(Date.now() / 1000)
    const index = db.prepare(`
      INSERT INTO sync_agent_index (
        client_id, client_name, local_agent_id, original_name, remote_name,
        role, status, framework, session_key, updated_at
      ) VALUES ('edge-a', 'Mac', ?, ?, ?, ?, 'idle', 'codex', ?, ?)
    `)
    index.run(7, 'Steward', 'edge-a-Steward', 'human-watch', 'steward-session', now)
    index.run(11, 'Worker', 'edge-a-Worker', 'developer', 'worker-session', now)
    db.prepare(`
      INSERT INTO agents (
        name, role, status, config, workspace_id, source, node_id, framework, hidden
      ) VALUES ('mac-worker', 'developer', 'idle', ?, 1, 'client', 'edge-a', 'codex', 0)
    `).run(JSON.stringify({ local_agent_id: 11, original_name: 'Worker', capabilities: ['backend'] }))
    createSupervisionGoal({
      id: 'goal-verify',
      workspaceId: 1,
      tenantId: 1,
      clientId: 'edge-a',
      stewardLocalAgentId: 7,
      title: 'Verify feature',
      objective: 'Implement and verify endpoint',
      successCriteria: [{ id: 'tests-pass', text: 'Automated tests pass', evidence_type: 'test' }],
      budget: {
        max_tasks: 2,
        max_parallel_workers: 1,
        max_retries_per_task: 1,
        max_replans: 1,
        max_runtime_seconds: 3600,
        max_model_calls: 10,
      },
      requiresPlanApproval: false,
      createdBy: '2',
    }, db)
    saveSupervisionGoalPlan({
      goalId: 'goal-verify',
      workspaceId: 1,
      createdByType: 'human_user',
      draft: {
        summary: 'Implement',
        tasks: [{
          logical_key: 'implement',
          title: 'Implement endpoint',
          description: 'Implement endpoint and tests',
          dependencies: [],
          required_capabilities: ['backend'],
          acceptance_criteria: ['Automated tests pass'],
          risk: 'low',
        }],
      },
    }, db)
    taskId = dispatchSupervisionGoal({ goalId: 'goal-verify', workspaceId: 1 }, {
      isClientOnline: () => true,
      wakeup: () => true,
    }, db).tasks[0].task_id
    db.prepare(`
      UPDATE tasks SET status = 'done', outcome = 'success', resolution = 'Implemented and tests pass', updated_at = unixepoch()
      WHERE id = ?
    `).run(taskId)
    db.prepare(`UPDATE supervision_goals SET status = 'verifying' WHERE id = 'goal-verify'`).run()
  })

  afterEach(() => db.close())

  it('does not accept Worker self-report without independent evidence', async () => {
    const runJudge = vi.fn()
    const result = await verifySupervisionGoal({ goalId: 'goal-verify', workspaceId: 1 }, { runJudge }, db)
    expect(result).toMatchObject({ decision: 'needs_human', status: 'blocked' })
    expect(result.reason).toContain('only Worker self-report')
    expect(runJudge).not.toHaveBeenCalled()
    expect(getSupervisionGoal('goal-verify', 1, db)?.status).toBe('blocked')
  })

  it('completes the goal only when every criterion cites valid independent evidence', async () => {
    db.prepare(`UPDATE tasks SET metadata = ? WHERE id = ?`).run(JSON.stringify({
      verification_evidence: [{ type: 'test', command: 'pnpm test', passed: true, summary: '1067 tests passed' }],
    }), taskId)
    const evidenceRef = `task:${taskId}:metadata-evidence:0`
    const runJudge = vi.fn(async () => ({
      reply: JSON.stringify({
        decision: 'accepted',
        reason: 'Independent automated test evidence satisfies the goal',
        criteria: [{
          criterion_id: 'tests-pass',
          passed: true,
          evidence_refs: [evidenceRef],
          note: 'Automated test evidence passed',
        }],
      }),
      sessionId: 'steward-session',
      source: 'test',
    }))
    const result = await verifySupervisionGoal({ goalId: 'goal-verify', workspaceId: 1 }, { runJudge }, db)
    expect(result).toMatchObject({ decision: 'accepted', status: 'completed' })
    expect(result.evidence_refs).toContain(evidenceRef)
    expect(getSupervisionGoal('goal-verify', 1, db)?.completed_at).toBeTypeOf('number')
    expect(listSupervisionGoalEvents('goal-verify', 1, db)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_type: 'goal_verification_completed', decision: 'accepted' }),
    ]))
  })

  it('treats a center-validated managed completion event as independent evidence', async () => {
    const inserted = db.prepare(`
      INSERT INTO supervision_events (
        workspace_id, tenant_id, goal_id, task_id, event_type, actor_type,
        actor_id, decision, reason, evidence_json, action_json, idempotency_key
      ) VALUES (1, 1, 'goal-verify', ?, 'goal_task_worker_completed', 'worker_agent',
        '11', 'success', 'command exited 0', ?, ?, 'goal-verify:managed-completion')
    `).run(
      taskId,
      JSON.stringify({ command: 'pnpm test', exit_code: 0, stdout: '1067 tests passed' }),
      JSON.stringify({ worker_local_agent_id: 11, worker_session_id: 'worker-session' }),
    )
    const eventId = Number(inserted.lastInsertRowid)
    const evidenceRef = `task:${taskId}:managed-completion:${eventId}`
    const runJudge = vi.fn(async ({ prompt }: { prompt: string }) => {
      expect(prompt).toContain('center_validated_worker_completion')
      expect(prompt).toContain('1067 tests passed')
      return {
        reply: JSON.stringify({
          decision: 'accepted',
          reason: 'Center-validated managed completion evidence satisfies the goal',
          criteria: [{
            criterion_id: 'tests-pass',
            passed: true,
            evidence_refs: [evidenceRef],
            note: 'The managed completion contains a passing test command and exact output',
          }],
        }),
        sessionId: 'steward-session',
        source: 'test',
      }
    })

    const result = await verifySupervisionGoal({ goalId: 'goal-verify', workspaceId: 1 }, { runJudge }, db)
    expect(result).toMatchObject({ decision: 'accepted', status: 'completed' })
    expect(result.evidence_refs).toContain(evidenceRef)
  })

  it('keeps production-sized managed completion prompts within the Edge judge limit', async () => {
    db.prepare(`UPDATE supervision_goals SET objective = ?, constraints_json = ? WHERE id = 'goal-verify'`).run(
      'Long production objective '.repeat(300),
      JSON.stringify(Array.from({ length: 20 }, (_, index) => `constraint-${index} ${'detail '.repeat(100)}`)),
    )
    db.prepare(`UPDATE tasks SET resolution = ? WHERE id = ?`).run('Worker completion detail '.repeat(400), taskId)
    const inserted = db.prepare(`
      INSERT INTO supervision_events (
        workspace_id, tenant_id, goal_id, task_id, event_type, actor_type,
        actor_id, decision, reason, evidence_json, action_json, idempotency_key
      ) VALUES (1, 1, 'goal-verify', ?, 'goal_task_worker_completed', 'worker_agent',
        '11', 'success', ?, ?, ?, 'goal-verify:large-managed-completion')
    `).run(
      taskId,
      'Repeated managed completion reason '.repeat(300),
      JSON.stringify({
        command: 'pwd',
        exit_code: 0,
        stdout: '/Users/kuangxb/Desktop/agent指挥仓\n',
        transcript: 'verbose transcript '.repeat(1000),
      }),
      JSON.stringify({ worker_local_agent_id: 11, worker_session_id: 'worker-session' }),
    )
    const evidenceRef = `task:${taskId}:managed-completion:${Number(inserted.lastInsertRowid)}`
    const runJudge = vi.fn(async ({ prompt }: { prompt: string }) => {
      expect(prompt.length).toBeLessThanOrEqual(5900)
      expect(prompt).toContain(evidenceRef)
      expect(prompt).toContain('center_validated_worker_completion')
      expect(prompt).toContain('/Users/kuangxb/Desktop/agent指挥仓')
      return {
        reply: JSON.stringify({
          decision: 'accepted',
          reason: 'Bounded managed evidence is sufficient',
          criteria: [{
            criterion_id: 'tests-pass',
            passed: true,
            evidence_refs: [evidenceRef],
            note: 'Center validated the managed completion',
          }],
        }),
        sessionId: 'steward-session',
        source: 'test',
      }
    })

    const result = await verifySupervisionGoal({ goalId: 'goal-verify', workspaceId: 1 }, { runJudge }, db)
    expect(result).toMatchObject({ decision: 'accepted', status: 'completed' })
  })

  it('downgrades unsupported acceptance evidence to human review', async () => {
    db.prepare(`UPDATE tasks SET metadata = ? WHERE id = ?`).run(JSON.stringify({
      verification_evidence: [{ type: 'test', passed: true }],
    }), taskId)
    const runJudge = vi.fn(async () => ({
      reply: JSON.stringify({
        decision: 'accepted',
        reason: 'Claimed accepted',
        criteria: [{
          criterion_id: 'tests-pass',
          passed: true,
          evidence_refs: ['fabricated:evidence'],
          note: 'Invalid reference',
        }],
      }),
      sessionId: 'steward-session',
      source: 'test',
    }))
    const result = await verifySupervisionGoal({ goalId: 'goal-verify', workspaceId: 1 }, { runJudge }, db)
    expect(result).toMatchObject({ decision: 'needs_human', status: 'blocked' })
    expect(result.reason).toContain('did not cite valid independent evidence')
  })
})
