import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import {
  getSupervisionGoal,
  listSupervisionGoalEvents,
  listSupervisionGoalTasks,
} from '@/lib/supervision-goals'

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
    source: 'center',
  })
}
