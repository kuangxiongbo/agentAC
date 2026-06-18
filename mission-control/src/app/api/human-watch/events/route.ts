import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import {
  listHumanWatchEvents,
  updateHumanWatchEvent,
} from '@/lib/human-watch-events'
import type {
  HumanWatchEventView,
  HumanWatchEventSource,
  HumanWatchEventStatus,
} from '@/lib/human-watch-types'

export const dynamic = 'force-dynamic'

function parsePositiveNumber(value: string | null, field: string): number | undefined | NextResponse {
  if (!value) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 1) {
    return NextResponse.json({ error: `Invalid ${field}` }, { status: 400 })
  }
  return parsed
}

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const params = request.nextUrl.searchParams
  const source = params.get('source')?.trim() as HumanWatchEventSource | undefined
  if (source && !['worker_tool', 'permission_request', 'transcript_rule', 'transcript_wait', 'system'].includes(source)) {
    return NextResponse.json({ error: 'Invalid source' }, { status: 400 })
  }

  const status = params.get('status')?.trim() as HumanWatchEventStatus | undefined
  if (status && !['pending', 'visible', 'claimed', 'resolved', 'dismissed', 'expired'].includes(status)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
  }

  const bindingId = parsePositiveNumber(params.get('binding_id'), 'binding_id')
  if (bindingId instanceof NextResponse) return bindingId
  const workerLocalAgentId = parsePositiveNumber(params.get('worker_local_agent_id'), 'worker_local_agent_id')
  if (workerLocalAgentId instanceof NextResponse) return workerLocalAgentId
  const stewardLocalAgentId = parsePositiveNumber(params.get('steward_local_agent_id'), 'steward_local_agent_id')
  if (stewardLocalAgentId instanceof NextResponse) return stewardLocalAgentId
  const limit = parsePositiveNumber(params.get('limit'), 'limit')
  if (limit instanceof NextResponse) return limit

  const rawEvents: HumanWatchEventView[] = listHumanWatchEvents({
    workspaceId: auth.user.workspace_id ?? 1,
    tenantId: auth.user.tenant_id ?? undefined,
    clientId: params.get('client_id')?.trim() || undefined,
    bindingId,
    workerLocalAgentId,
    stewardLocalAgentId,
    workerSessionId: params.get('worker_session_id')?.trim() || undefined,
    permissionRequestId: params.get('permission_request_id')?.trim() || undefined,
    source,
    status,
    limit,
  })

  const events = rawEvents.map((event) => {
    if (event.status !== 'pending') return event
    return (
      updateHumanWatchEvent(
        event.id,
        auth.user.workspace_id ?? 1,
        { status: 'visible' },
      ) ?? event
    )
  })

  return NextResponse.json({ events, count: events.length })
}
