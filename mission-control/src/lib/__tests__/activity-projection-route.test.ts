import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getProjection: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({ requireRole: mocks.requireRole }))
vi.mock('@/lib/work-activity-projection', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/work-activity-projection')>()
  return { ...original, getLiveWorkActivityProjection: mocks.getProjection }
})

describe('global activity projection route', () => {
  let db: Database.Database

  beforeEach(() => {
    vi.resetModules()
    db = new Database(':memory:')
    runMigrations(db)
    db.prepare(`INSERT INTO activities (
      id, type, entity_type, entity_id, actor, description, workspace_id, created_at
    ) VALUES (42, 'goal_created', 'goal', 1, 'steward', 'Cloud goal created', 1, 10)`).run()
    mocks.requireRole.mockReturnValue({ user: { id: 1, workspace_id: 1, role: 'admin' } })
    mocks.getProjection.mockResolvedValue({
      activities: [{
        id: -900,
        type: 'task_updated',
        entity_type: 'task',
        entity_id: 7,
        actor: 'Worker',
        description: 'Local task progressed',
        created_at: 30,
        source: 'local_runtime',
        authority: 'local_runtime',
        local_activity_id: '9',
        bridge_client_id: 'edge-a',
        client_id: 'edge-a',
        client_label: 'Mac A',
        data: { status: 'in_progress' },
      }],
      clients: [{ client_id: 'edge-a', client_label: 'Mac A', total: 1, truncated: false }],
      errors: [],
    })
    vi.doMock('@/lib/db', () => ({ getDatabase: () => db }))
  })

  afterEach(() => {
    db?.close()
    vi.clearAllMocks()
  })

  it('merges local runtime milestones ahead of cloud control activity', async () => {
    const route = await import('@/app/api/activities/route')
    const response = await route.GET(new NextRequest('http://localhost/api/activities?limit=50'))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ total: 2, authority: 'local_runtime', local_live: true, hasMore: false })
    expect(body.activities).toEqual([
      expect.objectContaining({ id: -900, source: 'local_runtime', bridge_client_id: 'edge-a' }),
      expect.objectContaining({ id: 42, source: 'cloud' }),
    ])
  })

  it('applies actor and type filters to both authorities', async () => {
    const route = await import('@/app/api/activities/route')
    const response = await route.GET(new NextRequest(
      'http://localhost/api/activities?actor=Worker&type=task_updated',
    ))
    const body = await response.json()
    expect(body.total).toBe(1)
    expect(body.activities).toEqual([
      expect.objectContaining({ type: 'task_updated', actor: 'Worker', source: 'local_runtime' }),
    ])
  })

  it('includes projected milestones in activity stats', async () => {
    const now = Math.floor(Date.now() / 1000)
    const projection = await mocks.getProjection()
    projection.activities[0].created_at = now
    mocks.getProjection.mockResolvedValue(projection)
    const route = await import('@/app/api/activities/route')
    const response = await route.GET(new NextRequest('http://localhost/api/activities?stats=1&hours=24'))
    const body = await response.json()
    expect(body.activityByType).toContainEqual({ type: 'task_updated', count: 1 })
    expect(body.topActors).toContainEqual({ actor: 'Worker', activity_count: 1 })
  })
})
