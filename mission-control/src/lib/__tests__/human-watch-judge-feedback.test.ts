import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'
import { createHumanWatchEvent, getHumanWatchEvent, updateHumanWatchEvent } from '@/lib/human-watch-events'

describe('human-watch judge suggestion feedback', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
  })

  afterEach(() => {
    db.close()
  })

  function seedEvent() {
    return createHumanWatchEvent(
      {
        workspaceId: 1,
        clientId: 'edge-a',
        workerName: 'worker-a',
        source: 'worker_tool',
        title: '需要确认',
        summary: 'worker 等待确认',
        suggestedAction: 'send_message_to_worker',
      },
      db,
    )
  }

  it('records accepted=true when a human resolves with the action the judge suggested', () => {
    const event = seedEvent()

    updateHumanWatchEvent(
      event.id,
      1,
      {
        status: 'resolved',
        resolvedAction: 'send_message_to_worker',
        resolvedByType: 'human_user',
        resolvedByUserId: 1,
      },
      db,
    )

    const updated = getHumanWatchEvent(event.id, 1, db)
    const audit = (updated?.context?.event_audit ?? []) as Array<Record<string, unknown>>
    const outcome = audit.find((entry) => entry.event_name === 'judge_suggestion_outcome')
    expect(outcome).toMatchObject({
      suggested_action: 'send_message_to_worker',
      resolved_action: 'send_message_to_worker',
      accepted: true,
    })
  })

  it('records accepted=false when a human overrides the judge suggestion', () => {
    const event = seedEvent()

    updateHumanWatchEvent(
      event.id,
      1,
      {
        status: 'resolved',
        resolvedAction: 'dismiss',
        resolvedByType: 'human_user',
        resolvedByUserId: 1,
      },
      db,
    )

    const updated = getHumanWatchEvent(event.id, 1, db)
    const audit = (updated?.context?.event_audit ?? []) as Array<Record<string, unknown>>
    const outcome = audit.find((entry) => entry.event_name === 'judge_suggestion_outcome')
    expect(outcome).toMatchObject({
      suggested_action: 'send_message_to_worker',
      resolved_action: 'dismiss',
      accepted: false,
    })
  })

  it('does not record feedback when the system (not a human) resolves the event', () => {
    const event = seedEvent()

    updateHumanWatchEvent(
      event.id,
      1,
      {
        status: 'resolved',
        resolvedAction: 'send_message_to_worker',
        resolvedByType: 'system',
      },
      db,
    )

    const updated = getHumanWatchEvent(event.id, 1, db)
    const audit = (updated?.context?.event_audit ?? []) as Array<Record<string, unknown>>
    expect(audit.find((entry) => entry.event_name === 'judge_suggestion_outcome')).toBeUndefined()
  })
})
