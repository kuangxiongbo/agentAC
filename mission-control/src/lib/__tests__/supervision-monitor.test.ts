import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'
import { dispatchSupervisionGoal } from '@/lib/supervision-dispatcher'
import { createSupervisionGoal, getSupervisionGoal, listSupervisionGoalEvents } from '@/lib/supervision-goals'
import { runSupervisionMonitor } from '@/lib/supervision-monitor'
import { saveSupervisionGoalPlan } from '@/lib/supervision-plans'

describe('supervision monitor', () => {
  let db: Database.Database
  let taskId: number
  const now = 2_000_000_000

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    const index = db.prepare(`
      INSERT INTO sync_agent_index (
        client_id, client_name, local_agent_id, original_name, remote_name,
        role, status, framework, session_key, updated_at
      ) VALUES ('edge-a', 'Mac', ?, ?, ?, ?, ?, 'codex', ?, ?)
    `)
    index.run(7, 'Steward', 'edge-a-Steward', 'human-watch', 'idle', 'steward-session', now)
    index.run(11, 'Worker', 'edge-a-Worker', 'developer', 'idle', 'worker-session', now)
    db.prepare(`
      INSERT INTO agents (
        name, role, status, config, workspace_id, source, node_id, framework, hidden
      ) VALUES ('mac-worker', 'developer', 'idle', ?, 1, 'client', 'edge-a', 'codex', 0)
    `).run(JSON.stringify({
      local_agent_id: 11,
      original_name: 'Worker',
      capabilities: ['backend'],
    }))
    createSupervisionGoal({
      id: 'goal-monitor',
      workspaceId: 1,
      tenantId: 1,
      clientId: 'edge-a',
      stewardLocalAgentId: 7,
      title: 'Monitor feature',
      objective: 'Implement the expected backend feature',
      successCriteria: [{ id: 'sc-1', text: 'Feature tests pass' }],
      constraints: ['Do not change unrelated files'],
      budget: {
        max_tasks: 2,
        max_parallel_workers: 1,
        max_retries_per_task: 2,
        max_replans: 1,
        max_runtime_seconds: 3600,
        max_model_calls: 10,
      },
      requiresPlanApproval: false,
      createdBy: '2',
    }, db)
    saveSupervisionGoalPlan({
      goalId: 'goal-monitor',
      workspaceId: 1,
      createdByType: 'human_user',
      draft: {
        summary: 'Implement',
        tasks: [{
          logical_key: 'implement',
          title: 'Implement backend',
          description: 'Implement only the expected endpoint',
          dependencies: [],
          required_capabilities: ['backend'],
          acceptance_criteria: ['Feature tests pass'],
          risk: 'low',
        }],
      },
    }, db)
    const dispatched = dispatchSupervisionGoal({ goalId: 'goal-monitor', workspaceId: 1 }, {
      isClientOnline: () => true,
      wakeup: () => true,
    }, db)
    taskId = dispatched.tasks[0].task_id
  })

  afterEach(() => db.close())

  it('detects offline, failed delivery, permission wait and timeout once under a lease', async () => {
    db.prepare(`UPDATE sync_agent_index SET status = 'offline', updated_at = ? WHERE local_agent_id = 11`).run(now)
    db.prepare(`
      UPDATE edge_messages
      SET status = 'dead_letter', last_error_code = 'EDGE_DOWN',
          last_error_message = 'Edge is unavailable', updated_at = ?
      WHERE correlation_id = ?
    `).run(now, `goal:goal-monitor:task:${taskId}`)
    db.prepare(`
      INSERT INTO permission_requests (
        id, workspace_id, tenant_id, client_id, worker_local_agent_id,
        worker_name, worker_session_id, request_type, title, prompt, risk,
        status, options_json, created_at, updated_at
      ) VALUES ('permission-1', 1, 1, 'edge-a', 11, 'Worker', 'worker-session',
        'confirmation', 'Confirm', 'Continue?', 'medium', 'pending', '[]', ?, ?)
    `).run(now - 10, now - 10)
    db.prepare(`UPDATE tasks SET estimated_hours = 1, updated_at = ? WHERE id = ?`).run(now - 8_000, taskId)

    const result = await runSupervisionMonitor({
      workspaceId: 1,
      ownerId: 'monitor-a',
      nowSeconds: now,
    }, { runJudge: vi.fn() }, db)
    expect(result).toMatchObject({ goals_scanned: 1, goals_leased: 1, semantic_checks: 0 })
    const types = listSupervisionGoalEvents('goal-monitor', 1, db).map((event) => event.event_type)
    expect(types).toEqual(expect.arrayContaining([
      'worker_offline_detected',
      'worker_dispatch_failure_detected',
      'worker_waiting_permission_detected',
      'task_timeout_detected',
    ]))

    const blockedByLease = await runSupervisionMonitor({
      workspaceId: 1,
      ownerId: 'monitor-b',
      nowSeconds: now,
    }, { runJudge: vi.fn() }, db)
    expect(blockedByLease.goals_leased).toBe(0)
  })

  it('uses the steward for semantic deviation detection and enters verification', async () => {
    db.prepare(`UPDATE tasks SET status = 'review', resolution = ?, updated_at = ? WHERE id = ?`)
      .run('Deleted unrelated files and skipped tests', now + 60, taskId)
    const runJudge = vi.fn(async () => ({
      reply: JSON.stringify({
        decision: 'deviated',
        confidence: 0.96,
        reason: 'Worker violated the unrelated-files constraint and supplied no test evidence',
        suggested_action: 'correct_direction',
      }),
      sessionId: 'steward-session',
      source: 'test',
    }))
    const semantic = await runSupervisionMonitor({
      workspaceId: 1,
      ownerId: 'monitor-semantic',
      nowSeconds: now + 60,
    }, { runJudge }, db)
    expect(semantic.semantic_checks).toBe(1)
    expect(runJudge).toHaveBeenCalledOnce()
    expect(listSupervisionGoalEvents('goal-monitor', 1, db)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event_type: 'worker_output_deviation_detected',
        decision: 'deviated',
      }),
    ]))

    db.prepare(`UPDATE tasks SET status = 'done', outcome = 'success', resolution = ?, updated_at = ? WHERE id = ?`)
      .run('Implemented endpoint and feature tests pass', now + 120, taskId)
    const alignedJudge = vi.fn(async () => ({
      reply: JSON.stringify({ decision: 'aligned', confidence: 0.9, reason: 'Output matches the goal' }),
      sessionId: 'steward-session',
      source: 'test',
    }))
    await runSupervisionMonitor({
      workspaceId: 1,
      ownerId: 'monitor-verify',
      nowSeconds: now + 120,
    }, { runJudge: alignedJudge }, db)
    expect(getSupervisionGoal('goal-monitor', 1, db)?.status).toBe('verifying')
    expect(listSupervisionGoalEvents('goal-monitor', 1, db)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_type: 'goal_verification_started' }),
    ]))
  })
})
