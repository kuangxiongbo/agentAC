import { describe, expect, it } from 'vitest'
import {
  buildDefaultBindingRulesOverride,
  buildDefaultStewardAgentConfig,
} from '@/lib/human-watch-defaults'

describe('human-watch-defaults', () => {
  it('buildDefaultBindingRulesOverride includes rule and intervention fields', () => {
    const rules = buildDefaultBindingRulesOverride()
    expect(rules.enabled).toBe(true)
    expect(rules.idle_timeout_seconds).toBe(5)
    expect(rules.idle_timeout_with_stuck_seconds).toBe(5)
    expect(rules.require_last_message_from_assistant).toBe(true)
    expect(rules.grace_after_prompt_seconds).toBe(0)
    expect(rules.max_interventions_per_hour).toBe(60)
    expect(rules.max_interventions_window_seconds).toBe(86400)
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
