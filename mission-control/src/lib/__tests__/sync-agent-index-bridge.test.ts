import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'

describe('sync-agent-index bridge hybrid', () => {
  let db: Database.Database

  beforeEach(() => {
    vi.resetModules()
    db = new Database(':memory:')
    runMigrations(db)
    vi.doMock('@/lib/db', () => ({
      getDatabase: () => db,
    }))
  })

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })

  it('replaces bridge agent index and removes stale rows', async () => {
    const { replaceBridgeAgentIndex, listBridgeAgentIndex, mergeDbAgentsWithBridgeIndex } =
      await import('@/lib/sync-agent-index')

    replaceBridgeAgentIndex('client-a', 'Mac', [
      { id: 1, name: 'Alpha', role: 'coder', status: 'idle' },
      { id: 2, name: 'Beta', role: 'agent', status: 'busy' },
    ])

    expect(listBridgeAgentIndex('client-a')).toHaveLength(2)

    replaceBridgeAgentIndex('client-a', 'Mac', [
      { id: 2, name: 'Beta', role: 'agent', status: 'idle' },
    ])

    const rows = listBridgeAgentIndex('client-a')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.original_name).toBe('Beta')

    const merged = mergeDbAgentsWithBridgeIndex([], rows, () => true)
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ source: 'bridge_index', bridge_online: true })
  })

  it('prefers bridge index over stale client mirror when bridge is online', async () => {
    const { replaceBridgeAgentIndex, listBridgeAgentIndex, mergeDbAgentsWithBridgeIndex } =
      await import('@/lib/sync-agent-index')

    replaceBridgeAgentIndex('client-a', 'Mac', [
      { id: 1, name: 'Alpha', role: 'coder', status: 'busy', framework: 'claude' },
    ])
    const rows = listBridgeAgentIndex('client-a')
    const staleClientMirror = {
      source: 'client',
      node_id: 'client-a',
      name: 'mac-alpha',
      status: 'idle',
      config: { original_name: 'Alpha' },
    }

    const mergedOnline = mergeDbAgentsWithBridgeIndex([staleClientMirror], rows, () => true)
    expect(mergedOnline).toHaveLength(1)
    expect(mergedOnline[0]).toMatchObject({ source: 'bridge_index', status: 'busy' })

    const mergedOffline = mergeDbAgentsWithBridgeIndex([staleClientMirror], rows, () => false)
    expect(mergedOffline).toHaveLength(1)
    expect(mergedOffline[0]).toMatchObject({ source: 'client', status: 'idle' })
  })

  it('dedupes client mirror by local_agent_id when bridge index has the same steward', async () => {
    const { replaceBridgeAgentIndex, listBridgeAgentIndex, mergeDbAgentsWithBridgeIndex } =
      await import('@/lib/sync-agent-index')

    replaceBridgeAgentIndex('client-a', 'Mac', [
      { id: 9, name: '24 小时智能值守', role: 'human-watch', status: 'idle', framework: 'codex-cli' },
    ])
    const rows = listBridgeAgentIndex('client-a')
    const mirroredClientAgent = {
      source: 'client',
      node_id: 'client-a',
      name: 'mac-24-watch',
      status: 'idle',
      config: { original_name: '历史名字', local_agent_id: 9 },
    }

    const mergedOnline = mergeDbAgentsWithBridgeIndex([mirroredClientAgent], rows, () => true)
    expect(mergedOnline).toHaveLength(1)
    expect(mergedOnline[0]).toMatchObject({ source: 'bridge_index' })

    const mergedOffline = mergeDbAgentsWithBridgeIndex([mirroredClientAgent], rows, () => false)
    expect(mergedOffline).toHaveLength(1)
    expect(mergedOffline[0]).toMatchObject({ source: 'client' })
  })

  it('resolves bridge recipient by remote_name or original_name', async () => {
    const { replaceBridgeAgentIndex, listBridgeAgentIndex, getBridgeAgentIndexByRecipient } =
      await import('@/lib/sync-agent-index')

    replaceBridgeAgentIndex('mac001', 'Mac', [
      {
        id: 7,
        name: '程序+人工值守测试',
        role: 'coder',
        status: 'idle',
        framework: 'codex',
        session_key: 'codex-thread-abc',
      },
    ])

    const row = listBridgeAgentIndex('mac001')[0]
    expect(row?.session_key).toBe('codex-thread-abc')

    expect(getBridgeAgentIndexByRecipient('mac001-程序+人工值守测试')?.local_agent_id).toBe(7)
    expect(getBridgeAgentIndexByRecipient('程序+人工值守测试')?.local_agent_id).toBe(7)
    expect(getBridgeAgentIndexByRecipient('missing')).toBeUndefined()
  })

  it('preserves session metadata when a legacy status push omits optional fields', async () => {
    const { replaceBridgeAgentIndex, listBridgeAgentIndex } = await import('@/lib/sync-agent-index')

    replaceBridgeAgentIndex('mac001', 'Mac', [
      {
        id: 44,
        name: '程序+人工值守测试',
        role: 'builder engineer',
        status: 'busy',
        framework: 'codex',
        parent_id: 3,
        session_key: '019e3a22-47cb',
      },
    ])

    replaceBridgeAgentIndex('mac001', 'Mac', [
      {
        id: 44,
        name: '程序+人工值守测试',
        role: 'builder engineer',
        status: 'idle',
      },
    ])

    expect(listBridgeAgentIndex('mac001')[0]).toMatchObject({
      status: 'idle',
      framework: 'codex',
      parent_local_id: 3,
      session_key: '019e3a22-47cb',
    })
  })
})
