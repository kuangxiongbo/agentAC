import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { validateBody } from '@/lib/validation'
import { updateSupervisionGoalSchema } from '@/lib/supervision-validation'
import { getSupervisionGoal, listSupervisionGoalEvents, listSupervisionGoalTasks, updateSupervisionGoal } from '@/lib/supervision-goals'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const { id } = await params
  const workspaceId = auth.user.workspace_id ?? 1
  const goal = getSupervisionGoal(id, workspaceId)
  if (!goal || (auth.user.tenant_id != null && goal.tenant_id !== auth.user.tenant_id)) {
    return NextResponse.json({ error: 'Goal not found' }, { status: 404 })
  }
  return NextResponse.json({
    goal,
    tasks: listSupervisionGoalTasks(id, workspaceId),
    events: listSupervisionGoalEvents(id, workspaceId),
  })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck
  const validated = await validateBody(request, updateSupervisionGoalSchema)
  if ('error' in validated) return validated.error
  const { id } = await params
  try {
    const body = validated.data
    const current = getSupervisionGoal(id, auth.user.workspace_id ?? 1)
    if (!current || (auth.user.tenant_id != null && current.tenant_id !== auth.user.tenant_id)) {
      return NextResponse.json({ error: 'Goal not found' }, { status: 404 })
    }
    const goal = updateSupervisionGoal({
      goalId: id,
      workspaceId: auth.user.workspace_id ?? 1,
      expectedVersion: body.version,
      actorId: String(auth.user.id),
      title: body.title,
      objective: body.objective,
      successCriteria: body.success_criteria,
      constraints: body.constraints,
      allowedWorkerIds: body.allowed_worker_ids,
      priority: body.priority,
      budget: body.budget,
      deadlineAt: body.deadline_at,
      requiresPlanApproval: body.requires_plan_approval,
    })
    return NextResponse.json({ goal })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update goal'
    return NextResponse.json({ error: message }, { status: message === 'GOAL_STATE_CONFLICT' ? 409 : 400 })
  }
}
