import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { createEdgeMessage } from '@/lib/edge-messages'
import { sendEdgeMessageWakeup } from '@/lib/bridge-server'

export const dynamic = 'force-dynamic'

const OPERATIONS = new Set(['update', 'delete'])
const MUTABLE_FIELDS = new Set([
  'title', 'description', 'status', 'priority', 'assigned_to', 'due_date',
  'estimated_hours', 'actual_hours', 'tags',
])

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  let body: Record<string, unknown>
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const clientId = String(body.client_id || '').trim()
  const localTaskId = Number(body.local_task_id)
  const expectedUpdatedAt = Number(body.expected_updated_at)
  const operation = String(body.operation || '')
  const idempotencyKey = String(body.idempotency_key || request.headers.get('x-idempotency-key') || '').trim()
  if (!clientId || !Number.isInteger(localTaskId) || localTaskId <= 0) {
    return NextResponse.json({ error: 'client_id and positive local_task_id are required' }, { status: 400 })
  }
  if (!Number.isInteger(expectedUpdatedAt) || expectedUpdatedAt <= 0) {
    return NextResponse.json({ error: 'expected_updated_at is required' }, { status: 400 })
  }
  if (!OPERATIONS.has(operation)) {
    return NextResponse.json({ error: 'operation must be update or delete' }, { status: 400 })
  }
  if (!idempotencyKey || idempotencyKey.length > 200) {
    return NextResponse.json({ error: 'idempotency_key is required and must be at most 200 characters' }, { status: 400 })
  }
  const changes = body.changes
  if (operation === 'update') {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      return NextResponse.json({ error: 'changes must be an object' }, { status: 400 })
    }
    const fields = Object.keys(changes)
    if (fields.length === 0 || fields.some((field) => !MUTABLE_FIELDS.has(field))) {
      return NextResponse.json({ error: 'changes contain no fields or unsupported fields' }, { status: 400 })
    }
  }

  try {
    const actor = auth.user.display_name || auth.user.username || 'cloud-control'
    const result = createEdgeMessage({
      workspaceId: auth.user.workspace_id ?? 1,
      tenantId: auth.user.tenant_id ?? undefined,
      clientId,
      type: 'work.task.mutation.requested',
      idempotencyKey: `work-task:${idempotencyKey}`,
      correlationId: typeof body.correlation_id === 'string' ? body.correlation_id : null,
      payload: {
        operation,
        local_task_id: localTaskId,
        workspace_id: auth.user.workspace_id ?? 1,
        expected_updated_at: expectedUpdatedAt,
        changes: operation === 'update' ? changes as Record<string, unknown> : undefined,
        actor,
      },
      maxAttempts: 5,
    })
    if (result.created) sendEdgeMessageWakeup(clientId, { message_id: result.message.id, type: result.message.type })
    return NextResponse.json({
      accepted: true,
      duplicate: result.duplicate,
      message_id: result.message.id,
      status: result.message.status,
      client_id: clientId,
      local_task_id: localTaskId,
    }, { status: result.created ? 202 : 200 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to queue local task mutation'
    return NextResponse.json({ error: message }, { status: /workspace/i.test(message) ? 403 : 400 })
  }
}
