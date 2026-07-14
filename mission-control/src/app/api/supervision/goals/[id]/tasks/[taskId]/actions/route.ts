import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { applySupervisionCorrection, type SupervisionCorrectionAction } from '@/lib/supervision-corrections'
import { getSupervisionGoal } from '@/lib/supervision-goals'

const ACTIONS: SupervisionCorrectionAction[] = [
  'request_progress',
  'correct_direction',
  'retry_task',
  'reassign_task',
  'request_replan',
  'escalate_human',
]

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; taskId: string }> },
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck
  const { id, taskId } = await params
  const goal = getSupervisionGoal(id, auth.user.workspace_id ?? 1)
  if (!goal || (auth.user.tenant_id != null && goal.tenant_id !== auth.user.tenant_id)) {
    return NextResponse.json({ error: 'Goal not found' }, { status: 404 })
  }
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const action = String(body.action || '') as SupervisionCorrectionAction
  if (!ACTIONS.includes(action)) return NextResponse.json({ error: 'Invalid correction action' }, { status: 400 })
  try {
    const result = applySupervisionCorrection({
      goalId: id,
      workspaceId: auth.user.workspace_id ?? 1,
      taskId: Number(taskId) || null,
      action,
      reason: String(body.reason || 'Manual supervision action'),
      instruction: typeof body.instruction === 'string' ? body.instruction : null,
      sourceEventId: Number.isFinite(Number(body.source_event_id)) ? Number(body.source_event_id) : null,
    })
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to apply correction'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
