import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { getSupervisionGoal } from '@/lib/supervision-goals'
import { verifySupervisionGoal } from '@/lib/supervision-verifier'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck
  const { id } = await params
  const goal = getSupervisionGoal(id, auth.user.workspace_id ?? 1)
  if (!goal || (auth.user.tenant_id != null && goal.tenant_id !== auth.user.tenant_id)) {
    return NextResponse.json({ error: 'Goal not found' }, { status: 404 })
  }
  try {
    return NextResponse.json(await verifySupervisionGoal({
      goalId: id,
      workspaceId: auth.user.workspace_id ?? 1,
    }))
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Verification failed' }, { status: 400 })
  }
}
