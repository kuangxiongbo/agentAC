import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import {
  createEdgeMessage,
  listEdgeMessages,
  type EdgeMessageDirection,
  type EdgeMessageStatus,
} from '@/lib/edge-messages'
import { sendEdgeMessageWakeup } from '@/lib/bridge-server'

export const dynamic = 'force-dynamic'

const STATUSES: EdgeMessageStatus[] = [
  'pending',
  'leased',
  'completed',
  'failed_retryable',
  'dead_letter',
  'cancelled',
]

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
  const status = params.get('status')?.trim() as EdgeMessageStatus | undefined
  if (status && !STATUSES.includes(status)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
  }
  const limit = parsePositiveNumber(params.get('limit'), 'limit')
  if (limit instanceof NextResponse) return limit

  const messages = listEdgeMessages({
    workspaceId: auth.user.workspace_id ?? 1,
    tenantId: auth.user.tenant_id ?? undefined,
    clientId: params.get('client_id')?.trim() || undefined,
    status,
    type: params.get('type')?.trim() || undefined,
    correlationId: params.get('correlation_id')?.trim() || undefined,
    limit,
  })

  return NextResponse.json({ messages, count: messages.length })
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
    const direction = typeof body.direction === 'string' ? body.direction as EdgeMessageDirection : undefined
    const result = createEdgeMessage({
      id: typeof body.id === 'string' ? body.id : undefined,
      workspaceId: auth.user.workspace_id ?? 1,
      tenantId: auth.user.tenant_id ?? undefined,
      clientId: String(body.client_id || ''),
      direction,
      type: String(body.type || ''),
      correlationId: typeof body.correlation_id === 'string' ? body.correlation_id : null,
      idempotencyKey: String(body.idempotency_key || ''),
      agentRef:
        body.agent_ref && typeof body.agent_ref === 'object' && !Array.isArray(body.agent_ref)
          ? body.agent_ref as Record<string, unknown>
          : null,
      sessionRef:
        body.session_ref && typeof body.session_ref === 'object' && !Array.isArray(body.session_ref)
          ? body.session_ref as { session_id: string; session_kind: string; serial_key?: string | null }
          : null,
      payload:
        body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
          ? body.payload as Record<string, unknown>
          : {},
      maxAttempts: numberOrNull(body.max_attempts),
      nextAttemptAt: numberOrNull(body.next_attempt_at),
    })
    if (result.created) {
      sendEdgeMessageWakeup(result.message.client_id, {
        message_id: result.message.id,
        type: result.message.type,
      })
    }
    return NextResponse.json(result, { status: result.created ? 201 : 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create edge message'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
