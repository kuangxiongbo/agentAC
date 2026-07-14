import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { requireHumanWatchEntitlement } from '@/lib/human-watch-policy'
import { validateBody } from '@/lib/validation'
import { createSupervisionGoalSchema } from '@/lib/supervision-validation'
import { createSupervisionGoal, listSupervisionGoals, type SupervisionGoalStatus } from '@/lib/supervision-goals'

export const dynamic = 'force-dynamic'

const GOAL_STATUSES: SupervisionGoalStatus[] = [
  'draft', 'planning', 'awaiting_plan_approval', 'running', 'blocked',
  'paused', 'verifying', 'completed', 'failed', 'cancelled',
]

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const status = request.nextUrl.searchParams.get('status')?.trim() as SupervisionGoalStatus | undefined
  if (status && !GOAL_STATUSES.includes(status)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
  }
  const stewardRaw = request.nextUrl.searchParams.get('steward_local_agent_id')
  const stewardLocalAgentId = stewardRaw ? Number(stewardRaw) : undefined
  if (stewardRaw && (!Number.isFinite(stewardLocalAgentId) || Number(stewardLocalAgentId) <= 0)) {
    return NextResponse.json({ error: 'Invalid steward_local_agent_id' }, { status: 400 })
  }
  const limit = Number(request.nextUrl.searchParams.get('limit') || 50)
  const offset = Number(request.nextUrl.searchParams.get('offset') || 0)
  const result = listSupervisionGoals({
    workspaceId: auth.user.workspace_id ?? 1,
    tenantId: auth.user.tenant_id ?? undefined,
    status,
    stewardLocalAgentId,
    limit,
    offset,
  })
  return NextResponse.json(result)
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck
  const tenantId = auth.user.tenant_id ?? 1
  const policy = await requireHumanWatchEntitlement(tenantId, auth.user.id, auth.user.portal_tenant_role)
  if (!policy.ok) return NextResponse.json({ error: policy.error }, { status: policy.status })
  const validated = await validateBody(request, createSupervisionGoalSchema)
  if ('error' in validated) return validated.error
  try {
    const body = validated.data
    const goal = createSupervisionGoal({
      workspaceId: auth.user.workspace_id ?? 1,
      tenantId,
      clientId: body.client_id,
      stewardLocalAgentId: body.steward_local_agent_id,
      title: body.title,
      objective: body.objective,
      successCriteria: body.success_criteria,
      constraints: body.constraints,
      allowedWorkerIds: body.allowed_worker_ids,
      priority: body.priority,
      budget: body.budget,
      deadlineAt: body.deadline_at,
      requiresPlanApproval: body.requires_plan_approval,
      createdBy: String(auth.user.id),
    })
    return NextResponse.json({ goal, correlation_id: `goal:${goal.id}:create` }, { status: 201 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to create goal' }, { status: 400 })
  }
}
