import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'
import { createSupervisionGoal } from '@/lib/supervision-goals'
import { matchSupervisionWorker } from '@/lib/supervision-worker-matcher'
import type { SupervisionPlanTask } from '@/lib/supervision-plans'

describe('supervision worker matcher', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    const insertIndex = db.prepare(`
      INSERT INTO sync_agent_index (
        client_id, client_name, local_agent_id, original_name, remote_name,
        role, status, framework, session_key, updated_at
      ) VALUES ('edge-a', 'Mac', ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const now = Math.floor(Date.now() / 1000)
    insertIndex.run(7, 'Steward', 'edge-a-Steward', 'human-watch', 'idle', 'codex', 'steward-session', now)
    insertIndex.run(11, 'Backend', 'edge-a-Backend', 'developer', 'idle', 'codex', 'backend-session', now)
    insertIndex.run(12, 'Tester', 'edge-a-Tester', 'tester', 'busy', 'claude-code', 'tester-session', now)
    insertIndex.run(13, 'Offline', 'edge-a-Offline', 'developer', 'offline', 'codex', 'offline-session', now)
    insertIndex.run(14, 'NoSession', 'edge-a-NoSession', 'developer', 'idle', 'codex', null, now)
    insertIndex.run(15, 'Legacy', 'edge-a-Legacy', 'developer', 'idle', 'openclaw', 'legacy-session', now)

    const insertAgent = db.prepare(`
      INSERT INTO agents (
        name, role, status, config, workspace_id, source, node_id, framework, hidden
      ) VALUES (?, ?, 'idle', ?, 1, 'client', 'edge-a', ?, 0)
    `)
    insertAgent.run('mac-backend', 'developer', JSON.stringify({
      local_agent_id: 11,
      original_name: 'Backend',
      capabilities: ['backend', 'database'],
      project_ids: [9],
      supervision: { high_risk_allowed: true },
    }), 'codex')
    insertAgent.run('mac-tester', 'tester', JSON.stringify({
      local_agent_id: 12,
      original_name: 'Tester',
      capabilities: ['testing'],
    }), 'claude-code')
  })

  afterEach(() => db.close())

  function createGoal(allowedWorkerIds: number[] = []) {
    return createSupervisionGoal({
      id: 'goal-match',
      workspaceId: 1,
      tenantId: 1,
      clientId: 'edge-a',
      stewardLocalAgentId: 7,
      title: 'Implement and verify',
      objective: 'Complete the feature',
      successCriteria: [{ id: 'sc-1', text: 'Tests pass' }],
      allowedWorkerIds,
      budget: {
        max_tasks: 4,
        max_parallel_workers: 2,
        max_retries_per_task: 2,
        max_replans: 2,
        max_runtime_seconds: 3600,
        max_model_calls: 20,
      },
      createdBy: '2',
    }, db)
  }

  const task: SupervisionPlanTask = {
    logical_key: 'implement',
    title: 'Implement backend',
    description: 'Implement the database endpoint',
    dependencies: [],
    required_capabilities: ['backend', 'database'],
    preferred_framework: 'codex-cli',
    acceptance_criteria: ['Unit tests pass'],
    risk: 'low',
  }

  it('excludes stewards and non-executable workers and selects by capability', () => {
    createGoal()
    const result = matchSupervisionWorker({ goalId: 'goal-match', workspaceId: 1, task }, {
      isClientOnline: () => true,
    }, db)

    expect(result.selected).toMatchObject({ local_agent_id: 11, assignment_name: 'mac-backend' })
    expect(result.candidates.map((candidate) => candidate.local_agent_id)).toEqual([11, 12])
    expect(result.rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({ local_agent_id: 7, reason: 'human_watch_not_executable' }),
      expect.objectContaining({ local_agent_id: 13, reason: 'worker_unavailable' }),
      expect.objectContaining({ local_agent_id: 14, reason: 'worker_session_missing' }),
      expect.objectContaining({ local_agent_id: 15, reason: 'framework_not_supported' }),
    ]))
  })

  it('honors the goal allowlist and current task capacity', () => {
    createGoal([11, 12])
    for (let index = 0; index < 3; index++) {
      db.prepare(`
        INSERT INTO tasks (title, status, assigned_to, created_by, workspace_id)
        VALUES (?, 'in_progress', 'mac-backend', 'test', 1)
      `).run(`Busy ${index}`)
    }
    const result = matchSupervisionWorker({ goalId: 'goal-match', workspaceId: 1, task }, {
      isClientOnline: () => true,
    }, db)
    expect(result.selected?.local_agent_id).toBe(12)
    expect(result.rejected).toContainEqual(expect.objectContaining({
      local_agent_id: 11,
      reason: 'worker_at_capacity',
    }))
  })

  it('requires explicit worker authorization for high-risk tasks', () => {
    createGoal()
    const result = matchSupervisionWorker({
      goalId: 'goal-match',
      workspaceId: 1,
      task: { ...task, risk: 'high' },
      projectId: 9,
    }, { isClientOnline: () => true }, db)
    expect(result.selected?.local_agent_id).toBe(11)
    expect(result.rejected).toContainEqual(expect.objectContaining({
      local_agent_id: 12,
      reason: 'high_risk_not_authorized',
    }))
    expect(result.selected?.reasons).toContain('same project experience')
  })

  it('returns no worker when the edge client is disconnected', () => {
    createGoal()
    const result = matchSupervisionWorker({ goalId: 'goal-match', workspaceId: 1, task }, {
      isClientOnline: () => false,
    }, db)
    expect(result.selected).toBeNull()
    expect(result.rejected).toHaveLength(6)
  })
})
