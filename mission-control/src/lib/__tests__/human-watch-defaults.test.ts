import { describe, expect, it } from 'vitest'
import {
  buildDefaultBindingRulesOverride,
  buildDefaultStewardAgentConfig,
} from '@/lib/human-watch-defaults'

describe('human-watch-defaults', () => {
  it('buildDefaultBindingRulesOverride includes rule and intervention fields', () => {
    const rules = buildDefaultBindingRulesOverride()
    expect(rules.enabled).toBe(true)
    expect(rules.idle_timeout_seconds).toBe(90)
    expect(rules.grace_after_prompt_seconds).toBe(30)
    expect(rules.max_interventions_per_hour).toBe(6)
    expect(typeof rules.prompt_template).toBe('string')
  })

  it('buildDefaultStewardAgentConfig embeds rules and binding_defaults', () => {
    const config = buildDefaultStewardAgentConfig()
    const steward = config.steward as Record<string, unknown>
    expect(config.agent_kind).toBe('human_watch')
    expect(steward.rules).toBeTruthy()
    expect(steward.binding_defaults).toBeTruthy()
  })
})
