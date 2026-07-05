import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { leaseEdgeMessages } from '@/lib/edge-messages'

export const dynamic = 'force-dynamic'

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
    const messages = leaseEdgeMessages({
      clientId: String(body.client_id || ''),
      leaseOwner: String(body.lease_owner || ''),
      limit: numberOrUndefined(body.limit),
      leaseSeconds: numberOrUndefined(body.lease_seconds),
      workspaceId: auth.user.workspace_id ?? 1,
      tenantId: auth.user.tenant_id ?? undefined,
      types: Array.isArray(body.types) ? body.types.map(String).filter(Boolean) : undefined,
    })
    return NextResponse.json({ messages, count: messages.length })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to lease edge messages'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  if (value == null || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

