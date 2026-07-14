import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { getStewardMemory, reviewStewardMemory } from '@/lib/steward-memories'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck
  const { id } = await params
  const existing = getStewardMemory(id, auth.user.workspace_id ?? 1)
  if (!existing || (auth.user.tenant_id != null && existing.tenant_id !== auth.user.tenant_id)) {
    return NextResponse.json({ error: 'Memory not found' }, { status: 404 })
  }
  try {
    const body = await request.json()
    const memory = reviewStewardMemory({
      id,
      workspaceId: auth.user.workspace_id ?? 1,
      action: body.action,
      reviewer: String(auth.user.id),
      content: typeof body.content === 'string' ? body.content : undefined,
      summary: typeof body.summary === 'string' ? body.summary : null,
      confidence: body.confidence == null ? undefined : Number(body.confidence),
      supersedesId: typeof body.supersedes_id === 'string' ? body.supersedes_id : null,
      expiresAt: Number.isFinite(Number(body.expires_at)) ? Number(body.expires_at) : null,
    })
    return NextResponse.json({ memory })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to review memory' }, { status: 400 })
  }
}
