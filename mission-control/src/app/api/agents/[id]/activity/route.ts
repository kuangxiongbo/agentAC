import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getDatabase } from '@/lib/db'
import { listAgentActivity } from '@/lib/agent-activity'
import { logger } from '@/lib/logger'
import { isBridgeClientOnline, requestBridgeClientAgentDetail } from '@/lib/bridge-server'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  try {
    const { id } = await params
    const requested = Number(new URL(request.url).searchParams.get('limit') || 50)
    const limit = Math.min(Math.max(Number.isFinite(requested) ? requested : 50, 1), 100)
    const result = listAgentActivity(getDatabase(), {
      agentId: id,
      workspaceId: auth.user.workspace_id ?? 1,
      limit,
    })
    if (!result) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    let localLive = false
    let localActivities: any[] = []
    const identity = result.identity
    if (
      identity.source === 'bridge_index'
      && identity.clientId
      && identity.localAgentId != null
      && isBridgeClientOnline(identity.clientId)
    ) {
      try {
        const remote = await requestBridgeClientAgentDetail({
          clientId: identity.clientId,
          localAgentId: identity.localAgentId,
        })
        const activities = remote.agent?.recent_activities
        const tasks = remote.agent?.recent_tasks
        if (Array.isArray(activities) && Array.isArray(tasks)) {
          localLive = true
          localActivities = [
            ...activities.map((activity) => ({
              ...activity,
              id: `local-activity:${activity.id}`,
              source: 'local_runtime',
              status: null,
            })),
            ...tasks.map((task) => ({
              id: `local-task:${task.id}:${task.updated_at}`,
              type: 'task_status',
              source: 'local_runtime',
              status: task.status || null,
              description: `Task #${task.id} ${task.title}`,
              created_at: task.updated_at || task.created_at,
              task_id: task.id,
            })),
          ]
        }
      } catch (error) {
        logger.warn({ err: error, clientId: identity.clientId }, 'Local agent activity detail unavailable')
      }
    }
    const activities = [...localActivities, ...result.activities]
      .sort((left, right) => Number(right.created_at || 0) - Number(left.created_at || 0))
      .slice(0, limit)
    return NextResponse.json({
      activities,
      total: activities.length,
      authority: identity.source === 'bridge_index' ? 'local_runtime' : 'cloud',
      local_live: localLive,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/agents/[id]/activity error')
    return NextResponse.json({ error: 'Failed to fetch agent activity' }, { status: 500 })
  }
}
