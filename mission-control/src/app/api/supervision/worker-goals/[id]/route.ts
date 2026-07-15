import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import {
  getSupervisionGoal,
  listSupervisionGoalEvents,
  listSupervisionGoalTasks,
} from '@/lib/supervision-goals'

export const dynamic = 'force-dynamic'

const EVENT_WINDOW_SIZE = 100

function parseStringArray(value: unknown): string[] {
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : []
  } catch {
    return []
  }
}

function compactText(value: unknown, maxLength = 1000): string | null {
  if (value == null) return null
  const text = String(value)
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`
}

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

  const tasks = listSupervisionGoalTasks(id, workspaceId)
  const allEvents = listSupervisionGoalEvents(id, workspaceId)
  const eventTypeCounts = allEvents.reduce<Record<string, number>>((counts, event) => {
    const type = String(event.event_type || 'unknown')
    counts[type] = (counts[type] || 0) + 1
    return counts
  }, {})
  const recentEvents = allEvents.slice(-EVENT_WINDOW_SIZE)

  return NextResponse.json({
    schema: 2,
    goal: {
      id: goal.id,
      title: goal.title,
      objective: compactText(goal.objective, 2000),
      status: goal.status,
      version: goal.version,
      current_plan_version: goal.current_plan_version,
      allowed_worker_ids: goal.allowed_worker_ids,
      steward_local_agent_id: goal.steward_local_agent_id,
      steward_session_id: goal.steward_session_id,
      budget: goal.budget,
      usage: goal.usage,
    },
    tasks: tasks.map((task) => ({
      task_id: task.task_id,
      logical_task_key: task.logical_task_key,
      dependencies: parseStringArray(task.dependencies_json),
      title: task.title,
      status: task.status,
      outcome: task.outcome,
      assigned_agent_id: task.assigned_agent_id,
      assigned_session_id: task.assigned_session_id,
      retry_count: task.retry_count,
      reassignment_count: task.reassignment_count,
      resolution_summary: compactText(task.resolution, 1000),
      error_summary: compactText(task.error_message, 500),
      updated_at: task.updated_at,
    })),
    event_summary: {
      total: allEvents.length,
      by_type: eventTypeCounts,
      latest_event_id: allEvents.length > 0 ? allEvents[allEvents.length - 1].id : null,
      returned: recentEvents.length,
      truncated: recentEvents.length < allEvents.length,
    },
    events: recentEvents.map((event) => ({
      id: event.id,
      task_id: event.task_id,
      event_type: event.event_type,
      actor_type: event.actor_type,
      actor_id: event.actor_id,
      decision: event.decision,
      reason: compactText(event.reason, 500),
      message_id: event.message_id,
      created_at: event.created_at,
    })),
    source: 'center',
  })
}
