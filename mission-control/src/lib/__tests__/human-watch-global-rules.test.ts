import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'
import {
  getHumanWatchGlobalRules,
  normalizeGlobalRulesPatch,
  resolveHumanWatchRulesForBinding,
  setHumanWatchGlobalRules,
} from '@/lib/human-watch-global-rules'
import type { HumanWatchBindingRow } from '@/lib/human-watch-bindings'

describe('human-watch-global-rules', () => {
  it('stores and reads tenant global rules', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    const tenant = db.prepare(`SELECT id FROM tenants LIMIT 1`).get() as { id: number }
    const tenantId = tenant.id

    setHumanWatchGlobalRules(
      tenantId,
      normalizeGlobalRulesPatch({
        idle_timeout_seconds: 45,
        confirmation_patterns: ['custom confirm'],
      }),
      db,
    )

    const rules = getHumanWatchGlobalRules(tenantId, db)
    expect(rules.idle_timeout_seconds).toBe(45)
    expect(rules.confirmation_patterns).toEqual(['custom confirm'])
    db.close()
  })

  it('allows five-second intervention thresholds for fast unattended watch', () => {
    const normalized = normalizeGlobalRulesPatch({
      idle_timeout_seconds: 5,
      idle_timeout_with_stuck_seconds: 5,
      grace_after_prompt_seconds: 0,
    })

    expect(normalized.idle_timeout_seconds).toBe(5)
    expect(normalized.idle_timeout_with_stuck_seconds).toBe(5)
    expect(normalized.grace_after_prompt_seconds).toBe(0)
  })

  it('resolveHumanWatchRulesForBinding ignores binding rules_override', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    const tenant = db.prepare(`SELECT id FROM tenants LIMIT 1`).get() as { id: number }
    setHumanWatchGlobalRules(tenant.id, { idle_timeout_seconds: 60 }, db)

    const binding = {
      tenant_id: tenant.id,
      rules_override: JSON.stringify({ idle_timeout_seconds: 999 }),
    } as HumanWatchBindingRow

    const rules = resolveHumanWatchRulesForBinding(binding, db)
    expect(rules.idle_timeout_seconds).toBe(60)
    db.close()
  })
})
