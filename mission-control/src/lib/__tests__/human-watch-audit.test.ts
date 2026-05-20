import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'
import {
  hashHumanWatchPrompt,
  listHumanWatchInterventions,
  logHumanWatchIntervention,
  truncateHumanWatchPromptPreview,
} from '@/lib/human-watch-audit'

describe('human-watch-audit', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
  })

  afterEach(() => {
    db.close()
  })

  function insertBinding(id: number) {
    db.prepare(
      `INSERT INTO human_watch_bindings (id, workspace_id, client_id, enabled, mode)
       VALUES (?, 1, 'mac-1', 1, 'auto_send')`,
    ).run(id)
  }

  it('logs intervention and lists by workspace', () => {
    insertBinding(1)
    const row = logHumanWatchIntervention(
      {
        workspaceId: 1,
        tenantId: 10,
        clientId: 'mac-1',
        bindingId: 1,
        workerLocalAgentId: 5,
        workerName: 'Worker A',
        stewardLocalAgentId: 9,
        stewardName: 'Steward B',
        workerSessionId: 'sess-abc',
        eventType: 'intervention_completed',
        decision: 'auto_send',
        rulesHit: { idle_timeout: true, confirmation_text: true },
        fingerprint: 'fp-1',
        promptPreview: 'Please continue with option A',
        outcome: 'success',
        bridgeRequestId: 'req-1',
      },
      db,
    )

    expect(row).not.toBeNull()
    expect(row?.event_type).toBe('intervention_completed')
    expect(row?.prompt_preview).toContain('option A')

    const listed = listHumanWatchInterventions({ workspaceId: 1, clientId: 'mac-1' }, db)
    expect(listed).toHaveLength(1)
    expect(listed[0]?.fingerprint).toBe('fp-1')
  })

  it('dedupes successful intervention_completed for same fingerprint', () => {
    insertBinding(2)
    const base = {
      workspaceId: 1,
      clientId: 'mac-1',
      bindingId: 2,
      fingerprint: 'fp-dup',
      eventType: 'intervention_completed' as const,
      decision: 'auto_send' as const,
      outcome: 'success' as const,
      promptPreview: 'same',
    }

    const first = logHumanWatchIntervention(base, db)
    const second = logHumanWatchIntervention(base, db)

    expect(first).not.toBeNull()
    expect(second).toBeNull()

    const listed = listHumanWatchInterventions({ workspaceId: 1, bindingId: 2 }, db)
    expect(listed).toHaveLength(1)
  })

  it('records skipped interventions separately', () => {
    insertBinding(3)
    logHumanWatchIntervention(
      {
        workspaceId: 1,
        clientId: 'mac-1',
        bindingId: 3,
        eventType: 'intervention_skipped',
        decision: 'skipped',
        outcome: 'skipped',
        skipReason: 'fingerprint_duplicate',
        fingerprint: 'fp-2',
      },
      db,
    )

    const listed = listHumanWatchInterventions({ workspaceId: 1, bindingId: 3 }, db)
    expect(listed[0]?.event_type).toBe('intervention_skipped')
    expect(listed[0]?.skip_reason).toBe('fingerprint_duplicate')
  })

  it('isolates workspaces in list query', () => {
    logHumanWatchIntervention(
      {
        workspaceId: 1,
        clientId: 'mac-1',
        eventType: 'rule_evaluated',
        decision: 'noop',
      },
      db,
    )
    logHumanWatchIntervention(
      {
        workspaceId: 2,
        clientId: 'mac-1',
        eventType: 'rule_evaluated',
        decision: 'noop',
      },
      db,
    )

    expect(listHumanWatchInterventions({ workspaceId: 1 }, db)).toHaveLength(1)
    expect(listHumanWatchInterventions({ workspaceId: 2 }, db)).toHaveLength(1)
  })

  it('isolates tenants in list query', () => {
    logHumanWatchIntervention(
      {
        workspaceId: 1,
        tenantId: 10,
        clientId: 'mac-1',
        eventType: 'rule_evaluated',
        decision: 'noop',
      },
      db,
    )
    logHumanWatchIntervention(
      {
        workspaceId: 1,
        tenantId: 20,
        clientId: 'mac-1',
        eventType: 'rule_evaluated',
        decision: 'noop',
      },
      db,
    )
    expect(listHumanWatchInterventions({ workspaceId: 1, tenantId: 10 }, db)).toHaveLength(1)
    expect(listHumanWatchInterventions({ workspaceId: 1, tenantId: 20 }, db)).toHaveLength(1)
    expect(listHumanWatchInterventions({ workspaceId: 1, tenantId: 99 }, db)).toHaveLength(0)
  })

  it('truncates prompt preview and hashes full text', () => {
    const long = 'x'.repeat(600)
    const preview = truncateHumanWatchPromptPreview(long)
    expect(preview.length).toBeLessThanOrEqual(501)
    expect(hashHumanWatchPrompt(long)).toHaveLength(64)
  })
})
