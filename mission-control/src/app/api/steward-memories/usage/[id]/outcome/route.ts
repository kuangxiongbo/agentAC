import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { recordStewardMemoryUsageOutcome } from '@/lib/steward-memory-search'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck
  try {
    const body = await request.json()
    if (!['helpful', 'harmful', 'irrelevant'].includes(String(body.outcome))) {
      return NextResponse.json({ error: 'Invalid memory outcome' }, { status: 400 })
    }
    const { id } = await params
    return NextResponse.json({ memory: recordStewardMemoryUsageOutcome({
      usageId: id,
      workspaceId: auth.user.workspace_id ?? 1,
      adopted: body.adopted === true,
      outcome: body.outcome,
      score: body.score == null ? null : Number(body.score),
    }) })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Memory outcome failed' }, { status: 400 })
  }
}
