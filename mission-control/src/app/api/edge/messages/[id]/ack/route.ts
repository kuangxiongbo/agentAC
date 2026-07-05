import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { ackEdgeMessage } from '@/lib/edge-messages'

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
    const message = ackEdgeMessage({
      id,
      clientId: String(body.client_id || ''),
      leaseOwner: typeof body.lease_owner === 'string' ? body.lease_owner : null,
      result:
        body.result && typeof body.result === 'object' && !Array.isArray(body.result)
          ? body.result as Record<string, unknown>
          : {},
    })
    return NextResponse.json({ message })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to ack edge message'
    return NextResponse.json({ error: message }, { status: /not found/i.test(message) ? 404 : 400 })
  }
}

