import { describe, expect, it } from 'vitest'
import {
  humanWatchBindingMatchesWorker,
  resolveHumanWatchStewardLabel,
} from '@/lib/agent-card-helpers'

describe('humanWatchBindingMatchesWorker', () => {
  it('matches by worker_local_agent_id', () => {
    const agent = {
      id: 99,
      source: 'bridge_index' as const,
      config: { local_agent_id: 7, bridge_client_id: 'mac001' },
    }
    expect(
      humanWatchBindingMatchesWorker(
        { worker_local_agent_id: 7, worker_sync_index_id: 12 },
        agent,
      ),
    ).toBe(true)
  })

  it('matches by worker_sync_index_id when local id missing on agent', () => {
    const agent = { id: 12, source: 'bridge_index' as const, config: {} }
    expect(
      humanWatchBindingMatchesWorker(
        { worker_local_agent_id: 7, worker_sync_index_id: 12 },
        agent,
      ),
    ).toBe(true)
  })
})

describe('resolveHumanWatchStewardLabel', () => {
  it('prefers steward_name from binding row', () => {
    expect(
      resolveHumanWatchStewardLabel(
        { steward_name: '程序+人工值守测试', steward_local_agent_id: 3 },
        [],
        'mac001',
      ),
    ).toBe('程序+人工值守测试')
  })

  it('falls back to agent list display name', () => {
    const label = resolveHumanWatchStewardLabel(
      { steward_name: null, steward_local_agent_id: 3 },
      [
        {
          name: 'mac001-值守A',
          source: 'bridge_index',
          node_id: 'mac001',
          config: { local_agent_id: 3, original_name: '值守A' },
        },
      ],
      'mac001',
    )
    expect(label).toBe('值守A')
  })
})
