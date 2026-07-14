import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { dispatchSupervisionGoal } from '@/lib/supervision-dispatcher'
import { getSupervisionGoal } from '@/lib/supervision-goals'

export const dynamic = 'force-dynamic'

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
  let body: { project_id?: number } = {}
  try {
    body = await request.json()
  } catch {
    body = {}
  }
  try {
    const result = dispatchSupervisionGoal({
      goalId: id,
      workspaceId: auth.user.workspace_id ?? 1,
      projectId: Number.isFinite(Number(body.project_id)) ? Number(body.project_id) : null,
    })
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to dispatch goal'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
