import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'
import {
  dispatchSupervisionGoal,
  SUPERVISION_TASK_HOLD_ASSIGNEE,
} from '@/lib/supervision-dispatcher'
import { createSupervisionGoal, listSupervisionGoalEvents } from '@/lib/supervision-goals'
import { saveSupervisionGoalPlan } from '@/lib/supervision-plans'

describe('supervision dispatcher', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    const now = Math.floor(Date.now() / 1000)
    const index = db.prepare(`
      INSERT INTO sync_agent_index (
        client_id, client_name, local_agent_id, original_name, remote_name,
        role, status, framework, session_key, updated_at
      ) VALUES ('edge-a', 'Mac', ?, ?, ?, ?, 'idle', ?, ?, ?)
    `)
    index.run(7, 'Steward', 'edge-a-Steward', 'human-watch', 'codex', 'steward-session', now)
    index.run(11, 'Backend', 'edge-a-Backend', 'developer', 'codex', 'backend-session', now)
    index.run(12, 'Tester', 'edge-a-Tester', 'tester', 'claude-code', 'tester-session', now)
    const agent = db.prepare(`
      INSERT INTO agents (
        name, role, status, config, workspace_id, source, node_id, framework, hidden
      ) VALUES (?, ?, 'idle', ?, 1, 'client', 'edge-a', ?, 0)
    `)
    agent.run('mac-backend', 'developer', JSON.stringify({
      local_agent_id: 11,
      original_name: 'Backend',
      capabilities: ['backend'],
    }), 'codex')
    agent.run('mac-tester', 'tester', JSON.stringify({
      local_agent_id: 12,
      original_name: 'Tester',
      capabilities: ['testing'],
    }), 'claude-code')

    createSupervisionGoal({
      id: 'goal-dispatch',
      workspaceId: 1,
      tenantId: 1,
      clientId: 'edge-a',
      stewardLocalAgentId: 7,
      title: 'Ship feature',
      objective: 'Implement and verify the feature',
      successCriteria: [{ id: 'sc-1', text: 'Tests pass' }],
      budget: {
        max_tasks: 4,
        max_parallel_workers: 2,
        max_retries_per_task: 2,
        max_replans: 2,
        max_runtime_seconds: 3600,
        max_model_calls: 20,
      },
      requiresPlanApproval: false,
      createdBy: '2',
    }, db)
    saveSupervisionGoalPlan({
      goalId: 'goal-dispatch',
      workspaceId: 1,
      createdByType: 'human_user',
      draft: {
        summary: 'Implement then verify',
        tasks: [
          {
            logical_key: 'implement',
            title: 'Implement',
            description: 'Implement the backend',
            dependencies: [],
            required_capabilities: ['backend'],
            preferred_framework: 'codex-cli',
            acceptance_criteria: ['Unit tests pass'],
            risk: 'low',
          },
          {
            logical_key: 'verify',
            title: 'Verify',
            description: 'Verify the implementation',
            dependencies: ['implement'],
            required_capabilities: ['testing'],
            preferred_framework: 'claude-code',
            acceptance_criteria: ['Integration tests pass'],
            risk: 'low',
          },
        ],
      },
    }, db)
  })

  afterEach(() => db.close())

  it('creates tasks once and only activates dependency-ready work', () => {
    const wakeup = vi.fn(() => true)
    const first = dispatchSupervisionGoal({ goalId: 'goal-dispatch', workspaceId: 1 }, {
      isClientOnline: () => true,
      wakeup,
    }, db)
    expect(first).toMatchObject({ created_count: 2, activated_count: 1, blocked_count: 1 })
    expect(first.tasks[0]).toMatchObject({
      logical_key: 'implement',
      status: 'in_progress',
      worker_local_agent_id: 11,
    })
    expect(first.tasks[1]).toMatchObject({
      logical_key: 'verify',
      status: 'inbox',
      blocked_reason: 'dependencies_not_completed',
    })
    const held = db.prepare(`SELECT status, assigned_to FROM tasks WHERE id = ?`)
      .get(first.tasks[1].task_id)
    expect(held).toEqual({
      status: 'inbox',
      assigned_to: SUPERVISION_TASK_HOLD_ASSIGNEE,
    })
    const legacyMutation = db.prepare(`
      UPDATE tasks SET status = 'assigned', assigned_to = 'legacy-worker'
      WHERE id = ? AND status = 'inbox' AND assigned_to IS NULL
    `).run(first.tasks[1].task_id)
    expect(legacyMutation.changes).toBe(0)
    expect(wakeup).toHaveBeenCalledOnce()
    expect((db.prepare(`SELECT COUNT(*) AS count FROM tasks`).get() as { count: number }).count).toBe(2)
    expect((db.prepare(`SELECT COUNT(*) AS count FROM edge_messages`).get() as { count: number }).count).toBe(1)
    const message = db.prepare(`SELECT payload_json FROM edge_messages LIMIT 1`).get() as { payload_json: string }
    expect(JSON.parse(message.payload_json)).toMatchObject({
      worker_local_agent_id: 11,
      session_id: 'backend-session',
      session_kind: 'codex-cli',
      dispatch_allowed_tools: ['Task', 'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write', 'TodoWrite'],
      dispatch_max_budget_usd: 5,
      dispatch_cwd: '.',
      execution_timeout_ms: 1_800_000,
    })

    const repeated = dispatchSupervisionGoal({ goalId: 'goal-dispatch', workspaceId: 1 }, {
      isClientOnline: () => true,
      wakeup,
    }, db)
    expect(repeated.created_count).toBe(0)
    expect((db.prepare(`SELECT COUNT(*) AS count FROM tasks`).get() as { count: number }).count).toBe(2)
    expect((db.prepare(`SELECT COUNT(*) AS count FROM edge_messages`).get() as { count: number }).count).toBe(1)
    expect(wakeup).toHaveBeenCalledOnce()
  })

  it('activates a dependent task after its predecessor is done', () => {
    const wakeup = vi.fn(() => true)
    const first = dispatchSupervisionGoal({ goalId: 'goal-dispatch', workspaceId: 1 }, {
      isClientOnline: () => true,
      wakeup,
    }, db)
    db.prepare(`UPDATE tasks SET status = 'done', outcome = 'success' WHERE id = ?`).run(first.tasks[0].task_id)

    const second = dispatchSupervisionGoal({ goalId: 'goal-dispatch', workspaceId: 1 }, {
      isClientOnline: () => true,
      wakeup,
    }, db)
    expect(second.tasks[1]).toMatchObject({
      logical_key: 'verify',
      status: 'in_progress',
      worker_local_agent_id: 12,
    })
    expect(db.prepare(`SELECT assigned_to FROM tasks WHERE id = ?`).get(second.tasks[1].task_id))
      .toEqual({ assigned_to: 'mac-tester' })
    expect((db.prepare(`SELECT COUNT(*) AS count FROM edge_messages`).get() as { count: number }).count).toBe(2)
    expect(wakeup).toHaveBeenCalledTimes(2)
    const events = listSupervisionGoalEvents('goal-dispatch', 1, db)
    expect(events.filter((event) => event.event_type === 'goal_task_dispatched')).toHaveLength(2)
  })

  it('does not dispatch two ready tasks to the same active worker session', () => {
    db.prepare(`UPDATE sync_agent_index SET session_key = 'backend-session' WHERE local_agent_id = 12`).run()
    const planRow = db.prepare(`
      SELECT id, plan_json FROM supervision_goal_plans
      WHERE goal_id = 'goal-dispatch' AND version = 1
    `).get() as { id: string; plan_json: string }
    const plan = JSON.parse(planRow.plan_json)
    plan.tasks.push({
      logical_key: 'implement-secondary',
      title: 'Implement secondary',
      description: 'Implement another backend change',
      dependencies: [],
      required_capabilities: ['backend'],
      preferred_framework: 'codex-cli',
      acceptance_criteria: ['Unit tests pass'],
      risk: 'low',
    })
    db.prepare(`UPDATE supervision_goal_plans SET plan_json = ? WHERE id = ?`)
      .run(JSON.stringify(plan), planRow.id)

    const result = dispatchSupervisionGoal({ goalId: 'goal-dispatch', workspaceId: 1 }, {
      isClientOnline: () => true,
      wakeup: () => true,
    }, db)

    const backendTasks = result.tasks.filter((task) => task.logical_key.startsWith('implement'))
    expect(backendTasks.filter((task) => task.status === 'in_progress')).toHaveLength(1)
    expect(backendTasks.filter((task) => task.blocked_reason === 'no_eligible_worker')).toHaveLength(1)
    expect((db.prepare(`SELECT COUNT(*) AS count FROM edge_messages`).get() as { count: number }).count).toBe(1)
  })
})
