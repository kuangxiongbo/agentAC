import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import {
  createPermissionRequest,
  listPermissionRequests,
  type PermissionRequestOption,
  type PermissionRequestRisk,
  type PermissionRequestStatus,
} from '@/lib/permission-requests'

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
  const status = params.get('status')?.trim() as PermissionRequestStatus | undefined
  if (status && !['pending', 'approved', 'denied', 'expired', 'cancelled'].includes(status)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
  }

  const workerLocalAgentId = parsePositiveNumber(params.get('worker_local_agent_id'), 'worker_local_agent_id')
  if (workerLocalAgentId instanceof NextResponse) return workerLocalAgentId
  const stewardLocalAgentId = parsePositiveNumber(params.get('steward_local_agent_id'), 'steward_local_agent_id')
  if (stewardLocalAgentId instanceof NextResponse) return stewardLocalAgentId
  const limit = parsePositiveNumber(params.get('limit'), 'limit')
  if (limit instanceof NextResponse) return limit

  const requests = listPermissionRequests({
    workspaceId: auth.user.workspace_id ?? 1,
    tenantId: auth.user.tenant_id ?? undefined,
    status,
    clientId: params.get('client_id')?.trim() || undefined,
    workerLocalAgentId,
    stewardLocalAgentId,
    limit,
  })

  return NextResponse.json({ requests, count: requests.length })
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  try {
    const options = Array.isArray(body.options) ? body.options as PermissionRequestOption[] : []
    const risk = String(body.risk || 'medium') as PermissionRequestRisk
    const request = createPermissionRequest({
      id: typeof body.id === 'string' ? body.id : undefined,
      workspaceId: auth.user.workspace_id ?? 1,
      tenantId: auth.user.tenant_id ?? undefined,
      clientId: typeof body.client_id === 'string' ? body.client_id.trim() : null,
      bindingId: numberOrNull(body.binding_id),
      workerSyncIndexId: numberOrNull(body.worker_sync_index_id),
      workerLocalAgentId: numberOrNull(body.worker_local_agent_id),
      workerName: typeof body.worker_name === 'string' ? body.worker_name : null,
      workerSessionId: typeof body.worker_session_id === 'string' ? body.worker_session_id : null,
      stewardSyncIndexId: numberOrNull(body.steward_sync_index_id),
      stewardLocalAgentId: numberOrNull(body.steward_local_agent_id),
      stewardName: typeof body.steward_name === 'string' ? body.steward_name : null,
      requestType: String(body.request_type || ''),
      title: String(body.title || ''),
      prompt: String(body.prompt || ''),
      risk,
      options,
      context:
        body.context && typeof body.context === 'object' && !Array.isArray(body.context)
          ? body.context as Record<string, unknown>
          : null,
      expiresAt: numberOrNull(body.expires_at),
    })
    return NextResponse.json({ request }, { status: 201 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create permission request'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
