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
  })
})
