import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { failEdgeMessage } from '@/lib/edge-messages'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  const { id } = await params
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  try {
    const message = failEdgeMessage({
      id,
      clientId: String(body.client_id || ''),
      leaseOwner: typeof body.lease_owner === 'string' ? body.lease_owner : null,
      errorCode: String(body.error_code || 'EDGE_MESSAGE_FAILED'),
      errorMessage: String(body.error_message || 'Edge message failed'),
      retryable: body.retryable !== false,
      result:
        body.result && typeof body.result === 'object' && !Array.isArray(body.result)
          ? body.result as Record<string, unknown>
          : {},
      nextAttemptAt: numberOrNull(body.next_attempt_at),
    })
    return NextResponse.json({ message })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to mark edge message failed'
    return NextResponse.json({ error: message }, { status: /not found/i.test(message) ? 404 : 400 })
  }
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

