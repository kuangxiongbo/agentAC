import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { cancelEdgeMessage } from '@/lib/edge-messages'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  const { id } = await params
  let body: Record<string, unknown> = {}
  try {
    body = await request.json()
  } catch {
    body = {}
  }

  try {
    const message = cancelEdgeMessage({
      id,
      workspaceId: auth.user.workspace_id ?? 1,
      reason: typeof body.reason === 'string' ? body.reason : null,
    })
    return NextResponse.json({ message })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to cancel edge message'
    return NextResponse.json({ error: message }, { status: /not found/i.test(message) ? 404 : 400 })
  }
}

