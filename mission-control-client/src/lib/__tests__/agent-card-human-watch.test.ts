import { describe, expect, it } from 'vitest'
import { isHumanWatchAgent, isSelectableOperativeAgent } from '@/lib/agent-card-helpers'

describe('agent-card human-watch', () => {
  it('detects steward by role', () => {
    expect(isHumanWatchAgent({ role: 'human-watch' })).toBe(true)
  })

  it('detects steward by config.agent_kind', () => {
    expect(
      isHumanWatchAgent({
        role: 'agent',
        config: { agent_kind: 'human_watch' },
      }),
    ).toBe(true)
  })

  it('excludes stewards from orchestration picker', () => {
    const agents = [
      { id: 1, name: 'worker', role: 'agent', config: {} },
      { id: 2, name: 'steward', role: 'human-watch', config: { agent_kind: 'human_watch' } },
    ]
    expect(isSelectableOperativeAgent(agents[1], agents)).toBe(false)
    expect(isSelectableOperativeAgent(agents[0], agents)).toBe(true)
  })
})
