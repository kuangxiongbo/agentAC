import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { recordWorkerHumanReply } from '@/lib/permission-requests'

export const dynamic = 'force-dynamic'

type RouteContext = {
  params: Promise<{ id: string }>
}

export async function POST(request: NextRequest, context: RouteContext) {
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

  const { id } = await context.params
  const requestId = String(id || '').trim()
  const selectedOptionId = String(body.selectedOptionId || body.selected_option_id || body.optionId || body.option_id || '').trim()
  if (!requestId) return NextResponse.json({ error: 'request id is required' }, { status: 400 })
  if (!selectedOptionId) return NextResponse.json({ error: 'selectedOptionId is required' }, { status: 400 })

  try {
    const updated = recordWorkerHumanReply({
      requestId,
      workspaceId: auth.user.workspace_id ?? 1,
      clientNodeId: typeof body.clientNodeId === 'string' ? body.clientNodeId : typeof body.client_node_id === 'string' ? body.client_node_id : null,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : typeof body.session_id === 'string' ? body.session_id : null,
      messageId: typeof body.messageId === 'string' ? body.messageId : typeof body.message_id === 'string' ? body.message_id : null,
      replyText: typeof body.replyText === 'string' ? body.replyText : typeof body.reply_text === 'string' ? body.reply_text : null,
      selectedOptionId,
      operatorUserId: auth.user.id ?? null,
      observedAt: typeof body.observedAt === 'string' ? body.observedAt : typeof body.observed_at === 'string' ? body.observed_at : null,
      idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : typeof body.idempotency_key === 'string' ? body.idempotency_key : null,
    })
    return NextResponse.json({ request: updated })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to record worker human reply'
    const status = message.includes('not found')
      ? 404
      : message.includes('pending') || message.includes('approved') || message.includes('denied') || message.includes('expired') || message.includes('cancelled')
        ? 409
        : message.includes('dangerous action')
          ? 403
          : 400
    return NextResponse.json({ error: message }, { status })
  }
}
