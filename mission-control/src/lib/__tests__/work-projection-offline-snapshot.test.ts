import { beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'

const bridge = vi.hoisted(() => ({
  clients: [] as Array<{ clientId: string; clientLabel: string; capabilities: string[] }>,
  taskSnapshot: vi.fn(),
  activitySnapshot: vi.fn(),
}))

vi.mock('@/lib/bridge-server', () => ({
  getConnectedBridgeClients: (capability?: string) => bridge.clients.filter((client) => !capability || client.capabilities.includes(capability)),
  requestBridgeClientTaskSnapshot: bridge.taskSnapshot,
  requestBridgeClientActivitySnapshot: bridge.activitySnapshot,
}))

import { clearWorkTaskProjectionCache, getLiveWorkTaskProjection } from '@/lib/work-task-projection'
import { clearWorkActivityProjectionCache, getLiveWorkActivityProjection } from '@/lib/work-activity-projection'
import { listWorkProjectionSnapshots, saveWorkProjectionSnapshot } from '@/lib/work-projection-snapshots'

describe('Work projection offline snapshots', () => {
  let db: Database.Database
  beforeEach(() => {
    db?.close()
    db = new Database(':memory:')
    runMigrations(db)
    db.prepare(`INSERT INTO sync_clients (client_id, client_name, workspace_id) VALUES ('edge-a', 'Mac A', 1), ('edge-b', 'Mac B', 2)`).run()
    bridge.clients = [{ clientId: 'edge-a', clientLabel: 'Mac A', capabilities: ['task_snapshot', 'activity_snapshot'] }]
    bridge.taskSnapshot.mockResolvedValue({ tasks: [{ id: 7, title: 'Local task', status: 'in_progress', updated_at: 20 }], total: 1, byStatus: { in_progress: 1 }, truncated: false })
    bridge.activitySnapshot.mockResolvedValue({ activities: [{ id: 9, type: 'task_updated', entity_type: 'task', entity_id: 7, actor: 'Worker', description: 'Progressed', created_at: 20 }], total: 1, truncated: false })
    clearWorkTaskProjectionCache()
    clearWorkActivityProjectionCache()
  })

  it('persists live facts and returns explicitly stale data after disconnect', async () => {
    const liveTasks = await getLiveWorkTaskProjection(db, 1, { fresh: true })
    const liveActivities = await getLiveWorkActivityProjection(db, 1, { fresh: true })
    expect(liveTasks.tasks[0]).toMatchObject({ source: 'local_runtime', authority: 'local_runtime', stale: false })
    expect(liveActivities.activities[0]).toMatchObject({ source: 'local_runtime', authority: 'local_runtime', stale: false })

    bridge.taskSnapshot.mockRejectedValueOnce(new Error('task timeout'))
    bridge.activitySnapshot.mockRejectedValueOnce(new Error('activity timeout'))
    const timedOutTasks = await getLiveWorkTaskProjection(db, 1, { fresh: true })
    const timedOutActivities = await getLiveWorkActivityProjection(db, 1, { fresh: true })
    expect(timedOutTasks).toMatchObject({ tasks: [expect.objectContaining({ source: 'local_snapshot' })], errors: [expect.objectContaining({ client_id: 'edge-a', error: 'task timeout' })] })
    expect(timedOutActivities).toMatchObject({ activities: [expect.objectContaining({ source: 'local_snapshot' })], errors: [expect.objectContaining({ client_id: 'edge-a', error: 'activity timeout' })] })

    bridge.clients = []
    const staleTasks = await getLiveWorkTaskProjection(db, 1, { fresh: true })
    const staleActivities = await getLiveWorkActivityProjection(db, 1, { fresh: true })
    expect(staleTasks.clients).toEqual([expect.objectContaining({ client_id: 'edge-a', live: false, stale: true })])
    expect(staleTasks.tasks[0]).toMatchObject({ source: 'local_snapshot', authority: 'local_snapshot', stale: true, snapshot_at: expect.any(Number) })
    expect(staleActivities.activities[0]).toMatchObject({ source: 'local_snapshot', authority: 'local_snapshot', stale: true, snapshot_at: expect.any(Number) })
  })

  it('replaces stale data after reconnect and isolates snapshots by workspace', async () => {
    await getLiveWorkTaskProjection(db, 1, { fresh: true })
    bridge.clients = []
    expect((await getLiveWorkTaskProjection(db, 1, { fresh: true })).tasks[0].source).toBe('local_snapshot')

    bridge.clients = [{ clientId: 'edge-a', clientLabel: 'Mac A', capabilities: ['task_snapshot'] }]
    bridge.taskSnapshot.mockResolvedValue({ tasks: [{ id: 7, title: 'Reconnected', status: 'done', updated_at: 30 }], total: 1, byStatus: { done: 1 }, truncated: false })
    const reconnected = await getLiveWorkTaskProjection(db, 1, { fresh: true })
    expect(reconnected.tasks).toEqual([expect.objectContaining({ title: 'Reconnected', source: 'local_runtime', stale: false })])
    expect((await getLiveWorkTaskProjection(db, 2, { fresh: true })).tasks).toEqual([])
  })

  it('does not fabricate a snapshot for an old client and drops expired snapshots', () => {
    bridge.clients = [{ clientId: 'edge-a', clientLabel: 'Mac A', capabilities: [] }]
    expect(listWorkProjectionSnapshots(db, 1, 'tasks')).toEqual([])
    saveWorkProjectionSnapshot(db, { workspaceId: 1, clientId: 'edge-a', clientLabel: 'Mac A', kind: 'tasks', payload: { tasks: [] }, capturedAt: 100 })
    expect(listWorkProjectionSnapshots(db, 1, 'tasks', [], 100 + 8 * 24 * 60 * 60)).toEqual([])
  })
})
