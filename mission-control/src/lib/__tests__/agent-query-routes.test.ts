import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'

const requireRole = vi.fn()
vi.mock('@/lib/auth', () => ({ requireRole }))
vi.mock('@/lib/rate-limit', () => ({
  agentHeartbeatLimiter: vi.fn(() => null),
  readLimiter: vi.fn(() => null),
  mutationLimiter: vi.fn(() => null),
}))

describe('bridge agent query routes', () => {
  let db: Database.Database
  let syncIndexId: number

  beforeEach(() => {
    vi.resetModules()
    db = new Database(':memory:')
    runMigrations(db)
    db.prepare(`INSERT INTO sync_clients (client_id, client_name, workspace_id)
      VALUES ('edge-a', 'Edge A', 1)`).run()
    const inserted = db.prepare(`
      INSERT INTO sync_agent_index (
        client_id, client_name, local_agent_id, original_name, remote_name,
        role, status, framework, session_key
      ) VALUES ('edge-a', 'Edge A', 10, '宣传视频制作', 'edge-a-宣传视频制作',
        'worker', 'busy', 'codex-cli', 'session-video')
    `).run()
    syncIndexId = Number(inserted.lastInsertRowid)
    db.prepare(`
      INSERT INTO supervision_goals (
        id, workspace_id, client_id, steward_local_agent_id, title, objective,
        success_criteria_json, budget_json, created_by
      ) VALUES ('goal-video', 1, 'edge-a', 7, 'Video goal', 'Make video', '[]', '{}', '1')
    `).run()
    db.prepare(`INSERT INTO tasks (
      id, title, status, assigned_to, workspace_id, created_at, updated_at
    ) VALUES (49, 'Render video', 'in_progress', 'mirror-name-not-in-index', 1, unixepoch(), unixepoch())`).run()
    db.prepare(`INSERT INTO supervision_goal_tasks (
      goal_id, task_id, plan_version, logical_task_key, assigned_agent_id, assigned_session_id
    ) VALUES ('goal-video', 49, 1, 'render', '10', 'session-video')`).run()
    db.prepare(`INSERT INTO comments (task_id, author, content, mentions, workspace_id, created_at)
      VALUES (49, 'steward', 'Please check output', '["宣传视频制作"]', 1, unixepoch())`).run()
    requireRole.mockReturnValue({ user: { id: 1, workspace_id: 1, role: 'admin' } })
    vi.doMock('@/lib/db', () => ({
      getDatabase: () => db,
      db_helpers: { getUnreadNotifications: () => [] },
    }))
    vi.doMock('@/lib/bridge-server', () => ({
      isBridgeClientOnline: () => false,
      requestBridgeClientAgentDetail: vi.fn(),
    }))
  })

  afterEach(() => {
    db?.close()
    vi.clearAllMocks()
  })

  it('lists supervision tasks even when assigned_to uses a missing mirror alias', async () => {
    const route = await import('@/app/api/agents/[id]/tasks/route')
    const response = await route.GET(
      new NextRequest('http://localhost/api/agents/1/tasks'),
      { params: Promise.resolve({ id: String(syncIndexId) }) },
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.tasks).toEqual([expect.objectContaining({ id: 49, status: 'in_progress' })])
  })

  it('returns assigned work from heartbeat for a bridge-index-only agent', async () => {
    const route = await import('@/app/api/agents/[id]/heartbeat/route')
    const response = await route.GET(
      new NextRequest('http://localhost/api/agents/edge-a-宣传视频制作/heartbeat'),
      { params: Promise.resolve({ id: 'edge-a-宣传视频制作' }) },
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('WORK_ITEMS_FOUND')
    expect(body.work_items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'assigned_tasks', count: 1 }),
      expect.objectContaining({ type: 'mentions', count: 1 }),
    ]))
  })

  it('uses local runtime snapshots for Work display when Bridge is online', async () => {
    vi.doMock('@/lib/bridge-server', () => ({
      isBridgeClientOnline: () => true,
      requestBridgeClientAgentDetail: vi.fn(async () => ({
        source: 'remote-bridge',
        agent: {
          updated_at: 200,
          soul_content: 'local soul',
          working_memory: 'local memory',
          recent_tasks: [{ id: 9, title: 'Local task', status: 'in_progress', created_at: 180, updated_at: 190 }],
          recent_activities: [{ id: 8, type: 'task_updated', description: 'Local execution', created_at: 195 }],
          workspace_source: '/local/workspace',
          workspace_files: {
            'identity.md': { exists: true, content: 'local identity' },
            'soul.md': { exists: true, content: 'workspace soul' },
            'WORKING.md': { exists: true, content: 'workspace memory' },
          },
        },
      })),
    }))

    db.prepare(`
      INSERT INTO agents (
        id, name, role, status, source, node_id, session_key, config, workspace_id
      ) VALUES (31, 'edge-a-legacy-video', 'worker', 'offline', 'client', 'edge-a',
        'legacy-session', ?, 1)
    `).run(JSON.stringify({ local_agent_id: 10, original_name: '宣传视频制作' }))

    const detailRoute = await import('@/app/api/agents/[id]/route')
    const detailBody = await (await detailRoute.GET(
      new NextRequest('http://localhost/api/agents/31'),
      { params: Promise.resolve({ id: '31' }) },
    )).json()
    expect(detailBody.agent).toMatchObject({
      id: syncIndexId,
      source: 'bridge_index',
      bridge_client_id: 'edge-a',
      edge_local_agent_id: 10,
      bridge_online: true,
      detail_live: true,
    })

    const params = { params: Promise.resolve({ id: String(syncIndexId) }) }
    const tasksRoute = await import('@/app/api/agents/[id]/tasks/route')
    const tasksBody = await (await tasksRoute.GET(
      new NextRequest(`http://localhost/api/agents/${syncIndexId}/tasks`), params,
    )).json()
    expect(tasksBody).toMatchObject({ authority: 'local_runtime', local_live: true })
    expect(tasksBody.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 9, source: 'local_runtime' }),
    ]))

    const activityRoute = await import('@/app/api/agents/[id]/activity/route')
    const activityBody = await (await activityRoute.GET(
      new NextRequest(`http://localhost/api/agents/${syncIndexId}/activity`), params,
    )).json()
    expect(activityBody).toMatchObject({ authority: 'local_runtime', local_live: true })
    expect(activityBody.activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ description: 'Local execution', source: 'local_runtime' }),
    ]))

    const filesRoute = await import('@/app/api/agents/[id]/files/route')
    const filesBody = await (await filesRoute.GET(
      new NextRequest(`http://localhost/api/agents/${syncIndexId}/files`), params,
    )).json()
    expect(filesBody).toMatchObject({ local_live: true, workspace: '/local/workspace' })
    expect(filesBody.files['identity.md'].content).toBe('local identity')

    const soulRoute = await import('@/app/api/agents/[id]/soul/route')
    const soulBody = await (await soulRoute.GET(
      new NextRequest(`http://localhost/api/agents/${syncIndexId}/soul`), params,
    )).json()
    expect(soulBody).toMatchObject({ soul_content: 'workspace soul', source: 'local_workspace' })

    const memoryRoute = await import('@/app/api/agents/[id]/memory/route')
    const memoryBody = await (await memoryRoute.GET(
      new NextRequest(`http://localhost/api/agents/${syncIndexId}/memory`), params,
    )).json()
    expect(memoryBody).toMatchObject({ working_memory: 'workspace memory', source: 'local_workspace' })
  })

  it('proxies diagnostics and attribution for a bridge-index Work agent', async () => {
    const requestBridgeClientAgentMetrics = vi.fn(async (input: any) => ({
      metric: input.metric,
      source: 'local_runtime',
      metrics: input.metric === 'diagnostics'
        ? { agent: { id: 10, name: '宣传视频制作' }, summary: { tasks_total: 3 } }
        : { agent_name: '宣传视频制作', audit: { total_activities: 2 } },
    }))
    vi.doMock('@/lib/bridge-server', () => ({
      isBridgeClientOnline: () => true,
      requestBridgeClientAgentDetail: vi.fn(),
      requestBridgeClientAgentMetrics,
    }))

    const diagnostics = await import('@/app/api/agents/[id]/diagnostics/route')
    const diagnosticsResponse = await diagnostics.GET(
      new NextRequest(`http://localhost/api/agents/${syncIndexId}/diagnostics?privileged=1&hours=48&section=summary`),
      { params: Promise.resolve({ id: String(syncIndexId) }) },
    )
    expect(diagnosticsResponse.status).toBe(200)
    expect(await diagnosticsResponse.json()).toMatchObject({
      summary: { tasks_total: 3 }, authority: 'local_runtime', local_live: true,
    })
    expect(requestBridgeClientAgentMetrics).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'edge-a', localAgentId: 10, metric: 'diagnostics', hours: 48, sections: ['summary'],
    }))

    const attribution = await import('@/app/api/agents/[id]/attribution/route')
    const attributionResponse = await attribution.GET(
      new NextRequest(`http://localhost/api/agents/${syncIndexId}/attribution?privileged=1&hours=24&section=audit`),
      { params: Promise.resolve({ id: String(syncIndexId) }) },
    )
    expect(attributionResponse.status).toBe(200)
    expect(await attributionResponse.json()).toMatchObject({
      audit: { total_activities: 2 }, access_scope: 'privileged', authority: 'local_runtime', local_live: true,
    })
  })

  it('merges cloud and Edge eval overviews when agent is omitted', async () => {
    db.prepare(`INSERT INTO eval_runs (agent_name, eval_layer, score, passed, detail, workspace_id, created_at)
      VALUES ('值守云端', 'output', 0.8, 1, 'ok', 1, unixepoch())`).run()
    vi.doMock('@/lib/bridge-server', () => ({
      getConnectedBridgeClients: () => [{ clientId: 'edge-a', clientLabel: 'Edge A', capabilities: ['agent_metrics'] }],
      requestBridgeClientAgentMetrics: vi.fn(async () => ({
        metric: 'evals', source: 'local_runtime', metrics: {
          agents: [{ name: '宣传视频制作', scores: [{ layer: 'output', score: 0.6, maxScore: 1 }], convergence: 0.6, driftDetected: false, lastEvalAt: 100 }],
        },
      })),
    }))
    const route = await import('@/app/api/agents/evals/route')
    const response = await route.GET(new NextRequest('http://localhost/api/agents/evals?timeframe=day'))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ authority: 'combined', overallConvergence: 0.7 })
    expect(body.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '值守云端', convergence: 0.8 }),
      expect.objectContaining({ name: 'edge-a-宣传视频制作', source: 'local_runtime', bridge_client_id: 'edge-a' }),
    ]))
  })

  it('merges Edge token records into stats and by-agent costs', async () => {
    vi.doMock('@/lib/bridge-server', () => ({
      getConnectedBridgeClients: () => [{ clientId: 'edge-a', clientLabel: 'Edge A', capabilities: ['agent_metrics'] }],
      requestBridgeClientAgentMetrics: vi.fn(async () => ({
        metric: 'tokens', source: 'local_runtime', metrics: { records: [{
          id: 'edge-token-1', model: 'gpt-5', sessionId: '宣传视频制作:codex-cli',
          agentName: '宣传视频制作', timestamp: Date.now(), inputTokens: 20,
          outputTokens: 10, totalTokens: 30, cost: 0.03, operation: 'chat', workspaceId: 1,
        }] },
      })),
    }))
    vi.doMock('@/lib/sessions', () => ({ getAllGatewaySessions: () => [] }))

    const tokensRoute = await import('@/app/api/tokens/route')
    const statsResponse = await tokensRoute.GET(new NextRequest('http://localhost/api/tokens?action=stats&timeframe=day'))
    expect(statsResponse.status).toBe(200)
    const stats = await statsResponse.json()
    expect(stats.agents['edge-a-宣传视频制作']).toMatchObject({ totalTokens: 30, totalCost: 0.03 })

    const byAgentRoute = await import('@/app/api/tokens/by-agent/route')
    const byAgentResponse = await byAgentRoute.GET(new NextRequest('http://localhost/api/tokens/by-agent?days=1'))
    expect(byAgentResponse.status).toBe(200)
    const byAgent = await byAgentResponse.json()
    expect(byAgent.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent: 'edge-a-宣传视频制作', total_tokens: 30, total_cost: 0.03 }),
    ]))
  })
})
