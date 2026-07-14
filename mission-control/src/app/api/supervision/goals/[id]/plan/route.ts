import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { validateBody } from '@/lib/validation'
import { createSupervisionPlanSchema } from '@/lib/supervision-validation'
import { getSupervisionGoal } from '@/lib/supervision-goals'
import {
  generateSupervisionGoalPlan,
  listSupervisionGoalPlans,
  saveSupervisionGoalPlan,
} from '@/lib/supervision-plans'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const { id } = await params
  const goal = getSupervisionGoal(id, auth.user.workspace_id ?? 1)
  if (!goal || (auth.user.tenant_id != null && goal.tenant_id !== auth.user.tenant_id)) {
    return NextResponse.json({ error: 'Goal not found' }, { status: 404 })
  }
  return NextResponse.json({ plans: listSupervisionGoalPlans(id, auth.user.workspace_id ?? 1) })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck
  const validated = await validateBody(request, createSupervisionPlanSchema)
  if ('error' in validated) return validated.error
  const { id } = await params
  const goal = getSupervisionGoal(id, auth.user.workspace_id ?? 1)
  if (!goal || (auth.user.tenant_id != null && goal.tenant_id !== auth.user.tenant_id)) {
    return NextResponse.json({ error: 'Goal not found' }, { status: 404 })
  }
  try {
    const body = validated.data
    const plan = body.mode === 'submit'
      ? saveSupervisionGoalPlan({
          goalId: id,
          workspaceId: auth.user.workspace_id ?? 1,
          draft: body.draft,
          rationale: body.rationale,
          sourceEventId: body.source_event_id,
          createdByType: 'human_user',
          actorId: String(auth.user.id),
        })
      : await generateSupervisionGoalPlan({
          goalId: id,
          workspaceId: auth.user.workspace_id ?? 1,
          actorId: String(auth.user.id),
          rationale: body.rationale,
        })
    return NextResponse.json({ plan }, { status: 201 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create plan'
    const status = message === 'GOAL_STATE_CONFLICT' ? 409 : 400
    return NextResponse.json({ error: message }, { status })
  }
}
