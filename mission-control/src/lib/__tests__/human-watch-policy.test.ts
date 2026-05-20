import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'
import {
  isHumanWatchEnabledForTenant,
  requireHumanWatchEnabled,
  setHumanWatchEnabledForTenant,
} from '@/lib/human-watch-policy'

describe('human-watch-policy', () => {
  let db: Database.Database
  const prevEnv = process.env.MC_HUMAN_WATCH_ENABLED

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
    db.prepare(`UPDATE tenants SET human_watch_enabled = 0 WHERE id = 1`).run()
    delete process.env.MC_HUMAN_WATCH_ENABLED
  })

  afterEach(() => {
    db.close()
    if (prevEnv == null) delete process.env.MC_HUMAN_WATCH_ENABLED
    else process.env.MC_HUMAN_WATCH_ENABLED = prevEnv
  })

  it('returns false when tenant flag is off', () => {
    expect(isHumanWatchEnabledForTenant(1, db)).toBe(false)
    expect(requireHumanWatchEnabled(1, db)).toEqual({
      ok: false,
      error: 'Human watch is not enabled for this tenant',
      status: 403,
    })
  })

  it('returns true after setHumanWatchEnabledForTenant', () => {
    setHumanWatchEnabledForTenant(1, true, db)
    expect(isHumanWatchEnabledForTenant(1, db)).toBe(true)
    expect(requireHumanWatchEnabled(1, db)).toEqual({ ok: true })
  })

  it('honors MC_HUMAN_WATCH_ENABLED env override', () => {
    process.env.MC_HUMAN_WATCH_ENABLED = 'true'
    expect(isHumanWatchEnabledForTenant(1, db)).toBe(true)
  })
})
