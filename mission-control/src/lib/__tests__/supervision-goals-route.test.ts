import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'

const requireRole = vi.fn()
const mutationLimiter = vi.fn(() => null)
const requireHumanWatchEntitlement = vi.fn()

vi.mock('@/lib/auth', () => ({ requireRole }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter }))
vi.mock('@/lib/human-watch-policy', () => ({ requireHumanWatchEntitlement }))

describe('supervision goal routes', () => {
  let db: Database.Database

  beforeEach(() => {
    vi.resetModules()
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    db.prepare(`
      INSERT INTO sync_agent_index (
        client_id, client_name, local_agent_id, original_name, remote_name,
        role, status, framework, session_key, updated_at
      ) VALUES ('edge-a', 'Mac', 7, 'Goal Steward', 'edge-a-Goal Steward',
        'human-watch', 'idle', 'codex', 'steward-session', unixepoch())
    `).run()
    db.prepare(`
      INSERT INTO sync_agent_index (
        client_id, client_name, local_agent_id, original_name, remote_name,
        role, status, framework, session_key, updated_at
      ) VALUES ('edge-a', 'Mac', 11, 'Backend Worker', 'edge-a-Backend Worker',
        'developer', 'idle', 'codex', 'worker-session', unixepoch())
    `).run()
    db.prepare(`
      INSERT INTO agents (
        name, role, status, config, workspace_id, source, node_id, framework, hidden
      ) VALUES ('mac-backend', 'developer', 'idle', ?, 1, 'client', 'edge-a', 'codex', 0)
    `).run(JSON.stringify({
      local_agent_id: 11,
      original_name: 'Backend Worker',
      capabilities: ['backend'],
    }))
    db.prepare(`
      INSERT INTO sync_clients (
        client_id, client_name, workspace_id, agent_count, last_seen,
        last_sync_source, created_at, updated_at
      ) VALUES ('edge-a', 'Mac', 1, 2, unixepoch(), 'test', unixepoch(), unixepoch())
    `).run()
    requireRole.mockReturnValue({
      user: {
        id: 2,
        workspace_id: 1,
        tenant_id: 1,
        role: 'operator',
        portal_tenant_role: 'admin',
      },
    })
    mutationLimiter.mockReturnValue(null)
    requireHumanWatchEntitlement.mockResolvedValue({ ok: true })
    vi.doMock('@/lib/db', () => ({ getDatabase: () => db }))
  })

  afterEach(() => {
    db.close()
    vi.clearAllMocks()
  })

  it('creates, lists and advances a goal through the API', async () => {
    const goalsRoute = await import('@/app/api/supervision/goals/route')
    const createResponse = await goalsRoute.POST(new NextRequest('http://localhost/api/supervision/goals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: 'edge-a',
        steward_local_agent_id: 7,
        title: 'Release goal',
        objective: 'Complete release verification',
        success_criteria: [{ id: 'sc-1', text: 'Tests pass', evidence_type: 'test' }],
      }),
    }))
    expect(createResponse.status).toBe(201)
    const created = await createResponse.json()
    expect(created.goal).toMatchObject({ status: 'planning', version: 1 })

    const listResponse = await goalsRoute.GET(new NextRequest('http://localhost/api/supervision/goals'))
    const listed = await listResponse.json()
    expect(listed.total).toBe(1)

    const planRoute = await import('@/app/api/supervision/goals/[id]/plan/route')
    const planResponse = await planRoute.POST(
      new NextRequest(`http://localhost/api/supervision/goals/${created.goal.id}/plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'submit',
          draft: {
            summary: 'Implement then verify',
            tasks: [{
              logical_key: 'implement',
              title: 'Implement',
              description: 'Implement the release change',
              dependencies: [],
              required_capabilities: ['backend'],
              acceptance_criteria: ['Tests pass'],
              risk: 'low',
            }],
          },
        }),
      }),
      { params: Promise.resolve({ id: created.goal.id }) },
    )
    expect(planResponse.status).toBe(201)
    expect((await planResponse.json()).plan).toMatchObject({ version: 1, status: 'draft' })

    const actionsRoute = await import('@/app/api/supervision/goals/[id]/actions/route')
    const actionResponse = await actionsRoute.POST(
      new NextRequest(`http://localhost/api/supervision/goals/${created.goal.id}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve_plan', version: 2, plan_version: 1 }),
      }),
      { params: Promise.resolve({ id: created.goal.id }) },
    )
    expect(actionResponse.status).toBe(200)
    const action = await actionResponse.json()
    expect(action.goal).toMatchObject({ status: 'running', current_plan_version: 1, version: 3 })

    const dispatchRoute = await import('@/app/api/supervision/goals/[id]/dispatch/route')
    const dispatchResponse = await dispatchRoute.POST(
      new NextRequest(`http://localhost/api/supervision/goals/${created.goal.id}/dispatch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      { params: Promise.resolve({ id: created.goal.id }) },
    )
    expect(dispatchResponse.status).toBe(200)
    const dispatched = await dispatchResponse.json()
    expect(dispatched).toMatchObject({ created_count: 1, activated_count: 1, blocked_count: 0 })
    expect(dispatched.tasks[0]).toMatchObject({
      logical_key: 'implement',
      status: 'in_progress',
      worker_local_agent_id: 11,
    })
    expect((db.prepare(`SELECT COUNT(*) AS count FROM edge_messages`).get() as { count: number }).count).toBe(1)

    const detailRoute = await import('@/app/api/supervision/goals/[id]/route')
    const detailResponse = await detailRoute.GET(
      new NextRequest(`http://localhost/api/supervision/goals/${created.goal.id}`),
      { params: Promise.resolve({ id: created.goal.id }) },
    )
    expect(detailResponse.status).toBe(200)
    const detail = await detailResponse.json()
    expect(detail.tasks).toEqual([
      expect.objectContaining({ logical_task_key: 'implement', status: 'in_progress' }),
    ])
    expect(detail.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_type: 'goal_task_dispatched' }),
    ]))
  })
})
