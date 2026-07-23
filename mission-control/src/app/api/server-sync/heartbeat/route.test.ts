import { beforeEach, describe, expect, it, vi } from 'vitest'

const replaceBridgeAgentIndex = vi.fn()
const upsertSyncClientHeartbeat = vi.fn()

vi.mock('@/lib/auth', () => ({
  requireRole: vi.fn(() => ({ user: { workspace_id: 1 } })),
}))
vi.mock('@/lib/config', () => ({ config: { centralMode: true } }))
vi.mock('@/lib/sync-clients', () => ({
  upsertSyncClientHeartbeat,
}))
vi.mock('@/lib/sync-agent-index', () => ({
  replaceBridgeAgentIndex,
}))
vi.mock('@/lib/sync-agent-inventory', () => ({
  parseAgentInventory: (value: unknown) => Array.isArray(value) ? value : [],
  reconcileClientAgentInventory: vi.fn(),
  cleanupDuplicateClientAgents: vi.fn(),
}))

describe('server sync heartbeat route', () => {
  beforeEach(() => {
    replaceBridgeAgentIndex.mockReset()
    replaceBridgeAgentIndex.mockReturnValue({ upserted: 1, removed: 0 })
    upsertSyncClientHeartbeat.mockReset()
    upsertSyncClientHeartbeat.mockReturnValue({ client_id: 'edge-a' })
  })

  it('refreshes the central agent index from a complete inventory', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/server-sync/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: 'edge-a',
        client_name: 'Mac',
        agent_count: 1,
        agent_inventory: [{
          local_agent_id: 10,
          original_name: '宣传视频制作',
          role: '视频创作',
          status: 'offline',
          framework: 'codex',
        }],
      }),
    }) as never)

    expect(response.status).toBe(200)
    expect(replaceBridgeAgentIndex).toHaveBeenCalledWith('edge-a', 'Mac', [{
      id: 10,
      name: '宣传视频制作',
      role: '视频创作',
      status: 'offline',
      framework: 'codex',
    }])
    expect(await response.json()).toMatchObject({
      agent_sync_mode: 'clients-only',
      agent_index_updated: 1,
    })
  })

  it('does not synthesize unstable ids for legacy inventory rows', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/server-sync/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: 'edge-a',
        client_name: 'Mac',
        agent_count: 1,
        agent_inventory: [{ original_name: 'legacy-agent' }],
      }),
    }) as never)

    expect(response.status).toBe(200)
    expect(replaceBridgeAgentIndex).not.toHaveBeenCalled()
    expect(await response.json()).toMatchObject({ agent_index_updated: 0 })
  })
})
