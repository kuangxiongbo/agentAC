import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { readLimiter, mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import {
  runOutputEvals,
  evalReasoningCoherence,
  evalToolReliability,
  runDriftCheck,
  getDriftTimeline,
  type EvalResult,
} from '@/lib/agent-evals'

const EVAL_TIMEFRAME_SECONDS: Record<string, number> = {
  hour: 3600, day: 86400, week: 7 * 86400, month: 30 * 86400,
}

export function buildAgentEvalsOverview(
  db: ReturnType<typeof getDatabase>,
  workspaceId: number,
  timeframe: string = 'day',
) {
  const since = Math.floor(Date.now() / 1000) - (EVAL_TIMEFRAME_SECONDS[timeframe] || EVAL_TIMEFRAME_SECONDS.day)
  const rows = db.prepare(`
    SELECT e.agent_name, e.eval_layer, e.score, e.passed, e.created_at
    FROM eval_runs e
    INNER JOIN (
      SELECT agent_name, eval_layer, MAX(created_at) AS max_created
      FROM eval_runs WHERE workspace_id = ? AND created_at >= ?
      GROUP BY agent_name, eval_layer
    ) latest ON latest.agent_name = e.agent_name
      AND latest.eval_layer = e.eval_layer AND latest.max_created = e.created_at
    WHERE e.workspace_id = ?
    ORDER BY e.agent_name, e.eval_layer
  `).all(workspaceId, since, workspaceId) as any[]
  const grouped = new Map<string, any[]>()
  for (const row of rows) grouped.set(row.agent_name, [...(grouped.get(row.agent_name) || []), row])
  const agents = [...grouped.entries()].map(([name, entries], index) => {
    const scores = entries.map((entry) => ({ layer: entry.eval_layer, score: Number(entry.score || 0), maxScore: 1 }))
    const convergence = scores.length > 0
      ? scores.reduce((sum, entry) => sum + entry.score, 0) / scores.length
      : 0
    return {
      agentId: index + 1,
      name,
      scores,
      convergence: Math.round(convergence * 100) / 100,
      driftDetected: entries.some((entry) => entry.eval_layer === 'drift' && !entry.passed),
      lastEvalAt: Math.max(...entries.map((entry) => Number(entry.created_at || 0))),
    }
  })
  const overallConvergence = agents.length > 0
    ? Math.round((agents.reduce((sum, agent) => sum + agent.convergence, 0) / agents.length) * 100) / 100
    : 0
  return {
    agents,
    overallConvergence,
    driftAlerts: agents.filter((agent) => agent.driftDetected).map((agent) => agent.name),
  }
}

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = readLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const { searchParams } = new URL(request.url)
    const agent = searchParams.get('agent')
    const action = searchParams.get('action')
    const workspaceId = auth.user.workspace_id ?? 1

    if (!agent) return NextResponse.json(buildAgentEvalsOverview(
      getDatabase(), workspaceId, searchParams.get('timeframe') || 'day',
    ))

    // History mode
    if (action === 'history') {
      const weeks = parseInt(searchParams.get('weeks') || '4', 10)
      const db = getDatabase()

      const history = db.prepare(`
        SELECT eval_layer, score, passed, detail, created_at
        FROM eval_runs
        WHERE agent_name = ? AND workspace_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(agent, workspaceId, weeks * 7) as any[]

      const driftTimeline = getDriftTimeline(agent, weeks, workspaceId)

      return NextResponse.json({
        agent,
        history,
        driftTimeline,
      })
    }

    // Default: latest eval results per layer
    const db = getDatabase()
    const latestByLayer = db.prepare(`
      SELECT e.eval_layer, e.score, e.passed, e.detail, e.created_at
      FROM eval_runs e
      INNER JOIN (
        SELECT eval_layer, MAX(created_at) as max_created
        FROM eval_runs
        WHERE agent_name = ? AND workspace_id = ?
        GROUP BY eval_layer
      ) latest ON e.eval_layer = latest.eval_layer AND e.created_at = latest.max_created
      WHERE e.agent_name = ? AND e.workspace_id = ?
    `).all(agent, workspaceId, agent, workspaceId) as any[]

    const driftResults = runDriftCheck(agent, workspaceId)
    const hasDrift = driftResults.some(d => d.drifted)

    return NextResponse.json({
      agent,
      layers: latestByLayer,
      drift: {
        hasDrift,
        metrics: driftResults,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/agents/evals error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { action } = body

    if (action === 'run') {
      const auth = requireRole(request, 'operator')
      if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

      const rateCheck = mutationLimiter(request)
      if (rateCheck) return rateCheck

      const { agent, layer } = body
      if (!agent) return NextResponse.json({ error: 'Missing: agent' }, { status: 400 })

      const workspaceId = auth.user.workspace_id ?? 1
      const db = getDatabase()
      const results: EvalResult[] = []

      const layers = layer ? [layer] : ['output', 'trace', 'component', 'drift']

      for (const l of layers) {
        let evalResults: EvalResult[] = []
        switch (l) {
          case 'output':
            evalResults = runOutputEvals(agent, 168, workspaceId)
            break
          case 'trace':
            evalResults = [evalReasoningCoherence(agent, 24, workspaceId)]
            break
          case 'component':
            evalResults = [evalToolReliability(agent, 24, workspaceId)]
            break
          case 'drift': {
            const driftResults = runDriftCheck(agent, workspaceId)
            const driftScore = driftResults.filter(d => !d.drifted).length / Math.max(driftResults.length, 1)
            evalResults = [{
              layer: 'drift',
              score: Math.round(driftScore * 100) / 100,
              passed: !driftResults.some(d => d.drifted),
              detail: driftResults.map(d => `${d.metric}: ${d.drifted ? 'DRIFTED' : 'stable'} (delta=${d.delta})`).join('; '),
            }]
            break
          }
        }

        for (const r of evalResults) {
          db.prepare(`
            INSERT INTO eval_runs (agent_name, eval_layer, score, passed, detail, workspace_id)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(agent, r.layer, r.score, r.passed ? 1 : 0, r.detail, workspaceId)
          results.push(r)
        }
      }

      return NextResponse.json({ agent, results })
    }

    if (action === 'golden-set') {
      const auth = requireRole(request, 'admin')
      if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

      const rateCheck = mutationLimiter(request)
      if (rateCheck) return rateCheck

      const { name, entries } = body
      if (!name) return NextResponse.json({ error: 'Missing: name' }, { status: 400 })

      const workspaceId = auth.user.workspace_id ?? 1
      const db = getDatabase()

      db.prepare(`
        INSERT INTO eval_golden_sets (name, entries, created_by, workspace_id)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(name, workspace_id)
        DO UPDATE SET entries = excluded.entries, updated_at = unixepoch()
      `).run(name, JSON.stringify(entries || []), auth.user.username, workspaceId)

      return NextResponse.json({ success: true, name })
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/agents/evals error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
