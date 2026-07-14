import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'
import { getHumanWatchHealthSummary } from '@/lib/human-watch-health'

describe('human-watch health summary', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
  })

  afterEach(() => {
    db.close()
  })

  it('reports only enabled binding outcomes and reliable message latency', () => {
    const now = Math.floor(Date.now() / 1000)
    db.prepare(`
      INSERT INTO human_watch_bindings (
        id, workspace_id, tenant_id, client_id,
        worker_local_agent_id, worker_name,
        steward_local_agent_id, steward_name,
        worker_session_id, worker_session_kind, enabled, mode
      ) VALUES
        (1, 1, 1, 'edge-a', 11, 'Worker', 21, 'Steward', 'session-1', 'codex-cli', 1, 'auto_send'),
        (2, 1, 1, 'edge-a', 12, 'Disabled Worker', 22, 'Disabled Steward', 'session-2', 'codex-cli', 0, 'auto_send')
    `).run()

    const insertIntervention = db.prepare(`
      INSERT INTO human_watch_interventions (
        workspace_id, tenant_id, client_id, binding_id,
        event_type, decision, outcome, skip_reason, created_at
      ) VALUES (1, 1, 'edge-a', ?, ?, ?, ?, ?, ?)
    `)
    insertIntervention.run(1, 'intervention_attempt', 'auto_send', null, null, now - 20)
    insertIntervention.run(1, 'intervention_completed', 'auto_send', 'success', null, now - 10)
    insertIntervention.run(2, 'intervention_skipped', 'skipped', null, 'steward_judge_failed', now - 5)

    db.prepare(`
      INSERT INTO edge_messages (
        id, workspace_id, tenant_id, client_id, direction, type, status,
        correlation_id, idempotency_key, payload_json, created_at, updated_at, completed_at
      ) VALUES (?, 1, 1, 'edge-a', 'cloud_to_edge', 'human_watch.assist.requested',
        'completed', 'correlation-1', 'idempotency-1', ?, ?, ?, ?)
    `).run(
      'message-1',
      JSON.stringify({ binding_id: 1 }),
      now - 9,
      now,
      now,
    )

    const summary = getHumanWatchHealthSummary({
      workspaceId: 1,
      tenantId: 1,
      windowSeconds: 86400,
    }, db)

    expect(summary.status).toBe('healthy')
    expect(summary.bindings).toEqual({ enabled: 1, with_session_kind: 1 })
    expect(summary.interventions).toMatchObject({
      attempts: 1,
      completed_success: 1,
      judge_failed: 0,
      decision_success_rate: 1,
      last_success_at: now - 10,
    })
    expect(summary.reliable_messages).toMatchObject({
      total: 1,
      completed: 1,
      completion_rate: 1,
      average_completion_seconds: 9,
      max_completion_seconds: 9,
    })
  })
})
