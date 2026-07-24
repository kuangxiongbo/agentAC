import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'
import { listAgentActivity } from '@/lib/agent-activity'

describe('agent activity aggregation', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    db.prepare(`
      INSERT INTO sync_clients (client_id, client_name, workspace_id)
      VALUES ('edge-a', 'Edge A', 1), ('edge-other', 'Other Edge', 2)
    `).run()
    db.prepare(`
      INSERT INTO sync_agent_index (
        client_id, client_name, local_agent_id, original_name, remote_name,
        role, status, framework, session_key, updated_at
      ) VALUES ('edge-a', 'Edge A', 10, '宣传视频制作', 'edge-a-宣传视频制作',
        'worker', 'busy', 'codex-cli', 'session-video', 100)
    `).run()
    db.prepare(`
      INSERT INTO supervision_goals (
        id, workspace_id, client_id, steward_local_agent_id, title, objective,
        success_criteria_json, budget_json, created_by
      ) VALUES ('goal-video', 1, 'edge-a', 7, 'Video goal', 'Make a video', '[]', '{}', '1')
    `).run()
    db.prepare(`
      INSERT INTO tasks (id, title, status, assigned_to, workspace_id, created_at, updated_at)
      VALUES (49, 'Render product video', 'done', 'edge-a-宣传视频制作', 1, 110, 140)
    `).run()
    db.prepare(`
      INSERT INTO supervision_goal_tasks (
        goal_id, task_id, plan_version, logical_task_key, assigned_agent_id, assigned_session_id
      ) VALUES ('goal-video', 49, 1, 'render', '10', 'session-video')
    `).run()
    db.prepare(`
      INSERT INTO supervision_events (
        workspace_id, goal_id, task_id, event_type, actor_type, decision, reason, created_at
      ) VALUES (1, 'goal-video', 49, 'task_verified', 'steward_agent', 'accepted', 'Output verified', 150)
    `).run()
    db.prepare(`
      INSERT INTO edge_messages (
        id, workspace_id, client_id, direction, type, status, correlation_id,
        idempotency_key, agent_ref_json, payload_json, created_at, updated_at
      ) VALUES ('message-49', 1, 'edge-a', 'cloud_to_edge', 'session.continue.requested',
        'completed', 'goal:video:task:49', 'dispatch-49', ?, ?, 120, 145)
    `).run(
      JSON.stringify({ local_agent_id: 10, agent_name: '宣传视频制作' }),
      JSON.stringify({ goal_id: 'goal-video', task_id: 49 }),
    )
    db.prepare(`
      INSERT INTO edge_message_events (message_id, event_type, from_status, to_status, created_at)
      VALUES ('message-49', 'completed', 'leased', 'completed', 145)
    `).run()
    db.prepare(`
      INSERT INTO sync_sessions (
        client_id, client_name, session_id, session_key, session_kind, active,
        last_activity, created_at, updated_at
      ) VALUES ('edge-a', 'Edge A', 'session-video', 'session-video', 'codex-cli', 1, 148, 100, 148)
    `).run()
  })

  afterEach(() => db?.close())

  it('shows real work for a bridge-index-only agent without an agents mirror row', () => {
    const index = db.prepare(`SELECT id FROM sync_agent_index WHERE client_id = 'edge-a'`).get() as { id: number }
    const result = listAgentActivity(db, { agentId: String(index.id), workspaceId: 1, limit: 50 })

    expect(result).not.toBeNull()
    expect(result?.activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'task', task_id: 49, status: 'done' }),
      expect.objectContaining({ source: 'supervision', type: 'task_verified', status: 'accepted' }),
      expect.objectContaining({ source: 'mailbox', message_id: 'message-49', status: 'completed' }),
      expect.objectContaining({ source: 'session', type: 'session_activity', status: 'active' }),
      expect.objectContaining({ source: 'sync', status: 'busy' }),
    ]))
  })

  it('does not expose an edge agent across workspaces', () => {
    const index = db.prepare(`SELECT id FROM sync_agent_index WHERE client_id = 'edge-a'`).get() as { id: number }
    expect(listAgentActivity(db, { agentId: String(index.id), workspaceId: 2, limit: 50 })).toBeNull()
  })
})
