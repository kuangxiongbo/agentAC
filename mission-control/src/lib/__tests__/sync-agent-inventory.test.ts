import { describe, expect, it } from 'vitest'
import {
  buildInventoryMatchSets,
  buildRemoteAgentRegistrationName,
  parseAgentInventory,
  shouldRetainClientSyncedAgent,
} from '@/lib/sync-agent-inventory'

describe('sync-agent-inventory', () => {
  it('parses agent_inventory payloads', () => {
    expect(
      parseAgentInventory([
        { original_name: 'Alpha', status: 'idle' },
        { original_name: '' },
        null,
      ]),
    ).toEqual([{ original_name: 'Alpha', status: 'idle' }])
  })

  it('matches by original_name and legacy remote name', () => {
    const clientName = 'My Mac'
    const inventory = [{ original_name: 'Coder' }]
    const matchSets = buildInventoryMatchSets(clientName, inventory)
    const remoteName = buildRemoteAgentRegistrationName(clientName, 'Coder')

    expect(
      shouldRetainClientSyncedAgent(
        { name: remoteName, config: JSON.stringify({ original_name: 'Coder' }) },
        matchSets,
      ),
    ).toBe(true)

    expect(
      shouldRetainClientSyncedAgent(
        { name: remoteName, config: '{}' },
        matchSets,
      ),
    ).toBe(true)

    expect(
      shouldRetainClientSyncedAgent(
        { name: 'my-mac-stale', config: JSON.stringify({ original_name: 'Stale' }) },
        matchSets,
      ),
    ).toBe(false)
  })
})
