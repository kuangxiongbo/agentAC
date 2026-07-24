import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { loadCombinedTokenData } from '../route'

interface ModelBreakdown {
  model: string
  input_tokens: number
  output_tokens: number
  request_count: number
  cost: number
}

interface AgentBreakdown {
  agent: string
  total_input_tokens: number
  total_output_tokens: number
  total_tokens: number
  total_cost: number
  session_count: number
  request_count: number
  last_active: string
  models: ModelBreakdown[]
}

/**
 * GET /api/tokens/by-agent - Per-agent cost breakdown from token_usage table
 * Query params:
 *   days=N  - Time window in days (default 30)
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const { searchParams } = new URL(request.url)
    const days = Math.max(1, Math.min(365, Number(searchParams.get('days') || 30)))
    const workspaceId = auth.user.workspace_id ?? 1

    const cutoff = Date.now() - days * 86400 * 1000
    const records = (await loadCombinedTokenData(workspaceId)).filter((record: any) => Number(record.timestamp) >= cutoff)
    const grouped = new Map<string, any[]>()
    for (const record of records) {
      const name = String(record.agentName || 'unknown')
      grouped.set(name, [...(grouped.get(name) || []), record])
    }
    const agents: AgentBreakdown[] = [...grouped.entries()].map(([agent, agentRecords]) => {
      const modelGroups = new Map<string, any[]>()
      for (const record of agentRecords) {
        const model = String(record.model || 'unknown')
        modelGroups.set(model, [...(modelGroups.get(model) || []), record])
      }
      const models: ModelBreakdown[] = [...modelGroups.entries()].map(([model, modelRecords]) => ({
        model,
        input_tokens: modelRecords.reduce((sum, record) => sum + Number(record.inputTokens || 0), 0),
        output_tokens: modelRecords.reduce((sum, record) => sum + Number(record.outputTokens || 0), 0),
        request_count: modelRecords.length,
        cost: modelRecords.reduce((sum, record) => sum + Number(record.cost || 0), 0),
      }))
      const inputTokens = models.reduce((sum, model) => sum + model.input_tokens, 0)
      const outputTokens = models.reduce((sum, model) => sum + model.output_tokens, 0)
      return {
        agent,
        total_input_tokens: inputTokens,
        total_output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        total_cost: models.reduce((sum, model) => sum + model.cost, 0),
        session_count: new Set(agentRecords.map((record) => String(record.sessionId || ''))).size,
        request_count: agentRecords.length,
        last_active: new Date(Math.max(...agentRecords.map((record) => Number(record.timestamp || 0)))).toISOString(),
        models,
      }
    }).sort((a, b) => b.total_tokens - a.total_tokens)

    const totalCost = agents.reduce((sum, a) => sum + a.total_cost, 0)
    const totalTokens = agents.reduce((sum, a) => sum + a.total_tokens, 0)

    return NextResponse.json({
      agents,
      summary: {
        total_cost: totalCost,
        total_tokens: totalTokens,
        agent_count: agents.length,
        days,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/tokens/by-agent error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
