import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { listHumanWatchInterventions } from '@/lib/human-watch-audit'

export const dynamic = 'force-dynamic'

/**
 * GET /api/human-watch/interventions
 * List human-watch intervention audit rows (append-only log).
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const workspaceId = auth.user.workspace_id ?? 1
  const params = request.nextUrl.searchParams

  const clientId = params.get('client_id')?.trim() || undefined
  const bindingIdRaw = params.get('binding_id')?.trim()
  const bindingId = bindingIdRaw ? Number(bindingIdRaw) : undefined
  if (bindingIdRaw && !Number.isFinite(bindingId)) {
    return NextResponse.json({ error: 'Invalid binding_id' }, { status: 400 })
  }

  const workerSyncIndexIdRaw = params.get('worker_sync_index_id')?.trim()
  const workerSyncIndexId = workerSyncIndexIdRaw ? Number(workerSyncIndexIdRaw) : undefined
  if (workerSyncIndexIdRaw && !Number.isFinite(workerSyncIndexId)) {
    return NextResponse.json({ error: 'Invalid worker_sync_index_id' }, { status: 400 })
  }

  const workerLocalAgentIdRaw = params.get('worker_local_agent_id')?.trim()
  const workerLocalAgentId = workerLocalAgentIdRaw ? Number(workerLocalAgentIdRaw) : undefined
  if (workerLocalAgentIdRaw && !Number.isFinite(workerLocalAgentId)) {
    return NextResponse.json({ error: 'Invalid worker_local_agent_id' }, { status: 400 })
  }

  const stewardLocalAgentIdRaw = params.get('steward_local_agent_id')?.trim()
  const stewardLocalAgentId = stewardLocalAgentIdRaw ? Number(stewardLocalAgentIdRaw) : undefined
  if (stewardLocalAgentIdRaw && !Number.isFinite(stewardLocalAgentId)) {
    return NextResponse.json({ error: 'Invalid steward_local_agent_id' }, { status: 400 })
  }

  const sinceRaw = params.get('since')?.trim()
  const since = sinceRaw ? Number(sinceRaw) : undefined
  if (sinceRaw && !Number.isFinite(since)) {
    return NextResponse.json({ error: 'Invalid since' }, { status: 400 })
  }

  const limitRaw = params.get('limit')?.trim()
  let limit: number | undefined
  if (limitRaw) {
    const parsedLimit = Number(limitRaw)
    if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
      return NextResponse.json({ error: 'Invalid limit' }, { status: 400 })
    }
    limit = parsedLimit
  }

  const interventions = listHumanWatchInterventions({
    workspaceId,
    tenantId: auth.user.tenant_id ?? undefined,
    clientId,
    bindingId,
    workerSyncIndexId,
    workerLocalAgentId,
    stewardLocalAgentId,
    since,
    limit,
  })

  return NextResponse.json({
    interventions: interventions.map((row) => ({
      ...row,
      rules_hit: row.rules_hit ? safeParseJson(row.rules_hit) : null,
      llm_sweep: Boolean(row.llm_sweep),
    })),
    count: interventions.length,
  })
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}
