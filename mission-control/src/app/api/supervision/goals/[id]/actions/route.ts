import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { validateBody } from '@/lib/validation'
import { supervisionGoalActionSchema } from '@/lib/supervision-validation'
import { applySupervisionGoalAction, getSupervisionGoal } from '@/lib/supervision-goals'

export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck
  const validated = await validateBody(request, supervisionGoalActionSchema)
  if ('error' in validated) return validated.error
  const { id } = await params
  const current = getSupervisionGoal(id, auth.user.workspace_id ?? 1)
  if (!current || (auth.user.tenant_id != null && current.tenant_id !== auth.user.tenant_id)) {
    return NextResponse.json({ error: 'Goal not found' }, { status: 404 })
  }
  try {
    const body = validated.data
    const goal = applySupervisionGoalAction({
      goalId: id,
      workspaceId: auth.user.workspace_id ?? 1,
      expectedVersion: body.version,
      action: body.action,
      actorId: String(auth.user.id),
      reason: body.reason,
      planVersion: body.plan_version,
    })
    return NextResponse.json({ goal })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to apply goal action'
    return NextResponse.json({ error: message }, { status: message === 'GOAL_STATE_CONFLICT' ? 409 : 400 })
  }
}
