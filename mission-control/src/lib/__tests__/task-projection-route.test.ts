import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getProjection: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({ requireRole: mocks.requireRole }))
vi.mock('@/lib/work-task-projection', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/work-task-projection')>()
  return { ...original, getLiveWorkTaskProjection: mocks.getProjection }
})

describe('global task projection route', () => {
  let db: Database.Database

  beforeEach(() => {
    vi.resetModules()
    db = new Database(':memory:')
    runMigrations(db)
    db.prepare(`INSERT INTO tasks (
      id, title, status, priority, project_id, created_by, workspace_id, created_at, updated_at, metadata
    ) VALUES (42, 'Cloud control', 'assigned', 'medium', 1, 'system', 1, 10, 10, '{}')`).run()
    mocks.requireRole.mockReturnValue({ user: { id: 1, workspace_id: 1, role: 'admin' } })
    mocks.getProjection.mockResolvedValue({
      tasks: [{
        id: -700,
        title: 'Local task',
        status: 'in_progress',
        priority: 'high',
        project_id: 1,
        created_by: 'local',
        created_at: 20,
        updated_at: 30,
        assigned_to: 'Worker',
        source: 'local_runtime',
        authority: 'local_runtime',
        local_task_id: 7,
        bridge_client_id: 'edge-a',
        client_id: 'edge-a',
        client_label: 'Mac A',
        tags: [],
        metadata: {},
      }],
      clients: [{ client_id: 'edge-a', client_label: 'Mac A', total: 1, by_status: { in_progress: 1 }, truncated: false }],
      errors: [],
    })
    vi.doMock('@/lib/db', () => ({ getDatabase: () => db, db_helpers: {} }))
  })

  afterEach(() => {
    db.close()
    vi.clearAllMocks()
  })

  it('merges local runtime tasks into the cloud task board response', async () => {
    const route = await import('@/app/api/tasks/route')
    const response = await route.GET(new NextRequest('http://localhost/api/tasks?limit=50'))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ total: 2, authority: 'local_runtime', local_live: true })
    expect(body.tasks).toEqual([
      expect.objectContaining({ id: -700, source: 'local_runtime', local_task_id: 7 }),
      expect.objectContaining({ id: 42, source: 'cloud_control' }),
    ])
  })

  it('filters projected tasks by bridge client', async () => {
    const route = await import('@/app/api/tasks/route')
    const response = await route.GET(new NextRequest('http://localhost/api/tasks?client_id=edge-b'))
    const body = await response.json()
    expect(body.tasks).toEqual([])
    expect(body.total).toBe(0)
  })

  it('dedupes a local mirror from the exact total', async () => {
    const projection = await mocks.getProjection()
    projection.tasks[0].metadata = { remote_task_id: 42 }
    mocks.getProjection.mockResolvedValue(projection)

    const route = await import('@/app/api/tasks/route')
    const response = await route.GET(new NextRequest('http://localhost/api/tasks?limit=1'))
    const body = await response.json()
    expect(body.total).toBe(1)
    expect(body.tasks).toEqual([
      expect.objectContaining({ source: 'local_runtime', metadata: expect.objectContaining({ cloud_task_id: 42 }) }),
    ])
  })
})
