import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, type Activity } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { getLiveWorkActivityProjection, type ProjectedWorkActivity } from '@/lib/work-activity-projection'

type ActivityRow = Activity & Record<string, unknown>

function parseLimit(value: string | null): number {
  const parsed = Number.parseInt(value || '50', 10)
  return Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, 500)) : 50
}

function parseOffset(value: string | null): number {
  const parsed = Number.parseInt(value || '0', 10)
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0
}

function parseTypes(value: string | null): string[] {
  return value?.split(',').map((type) => type.trim()).filter(Boolean) || []
}

function parseData(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function enhanceCloudActivities(db: ReturnType<typeof getDatabase>, activities: ActivityRow[], workspaceId: number) {
  const taskDetail = db.prepare('SELECT id, title, status FROM tasks WHERE id = ? AND workspace_id = ?')
  const agentDetail = db.prepare('SELECT id, name, role, status FROM agents WHERE id = ? AND workspace_id = ?')
  const commentDetail = db.prepare(`
    SELECT c.id, c.content, c.task_id, t.title AS task_title
    FROM comments c
    LEFT JOIN tasks t ON c.task_id = t.id
    WHERE c.id = ? AND c.workspace_id = ? AND t.workspace_id = ?
  `)
  return activities.map((activity) => {
    let entity: Record<string, unknown> | null = null
    try {
      if (activity.entity_type === 'task') {
        const task = taskDetail.get(activity.entity_id, workspaceId) as Record<string, unknown> | undefined
        if (task) entity = { type: 'task', ...task }
      } else if (activity.entity_type === 'agent') {
        const agent = agentDetail.get(activity.entity_id, workspaceId) as Record<string, unknown> | undefined
        if (agent) entity = { type: 'agent', ...agent }
      } else if (activity.entity_type === 'comment') {
        const comment = commentDetail.get(activity.entity_id, workspaceId, workspaceId) as Record<string, unknown> | undefined
        if (comment) entity = {
          type: 'comment',
          ...comment,
          content_preview: String(comment.content || '').substring(0, 100),
        }
      }
    } catch (error) {
      logger.warn({ err: error, activityId: activity.id }, 'Failed to fetch entity details for activity')
    }
    return { ...activity, source: 'cloud', authority: 'cloud', data: parseData(activity.data), entity }
  })
}

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  try {
    const url = new URL(request.url)
    const workspaceId = auth.user.workspace_id ?? 1
    if (url.pathname.endsWith('/stats') || url.searchParams.has('stats')) {
      return handleStatsRequest(url, workspaceId)
    }
    return handleActivitiesRequest(url, workspaceId)
  } catch (error) {
    logger.error({ err: error }, 'GET /api/activities error')
    return NextResponse.json({ error: 'Failed to process request' }, { status: 500 })
  }
}

async function handleActivitiesRequest(url: URL, workspaceId: number) {
  try {
    const db = getDatabase()
    const types = parseTypes(url.searchParams.get('type'))
    const actor = url.searchParams.get('actor')
    const entityType = url.searchParams.get('entity_type')
    const clientId = url.searchParams.get('client_id')
    const sinceValue = Number.parseInt(url.searchParams.get('since') || '', 10)
    const since = Number.isFinite(sinceValue) ? sinceValue : null
    const limit = parseLimit(url.searchParams.get('limit'))
    const offset = parseOffset(url.searchParams.get('offset'))

    let projection = { activities: [] as ProjectedWorkActivity[], clients: [] as any[], errors: [] as any[] }
    try {
      projection = await getLiveWorkActivityProjection(db, workspaceId)
    } catch (error) {
      logger.warn({ err: error, workspaceId }, 'GET /api/activities edge projection unavailable')
    }
    const localActivities = projection.activities.filter((activity) => {
      if (clientId && activity.bridge_client_id !== clientId) return false
      if (types.length && !types.includes(activity.type)) return false
      if (actor && activity.actor !== actor) return false
      if (entityType && activity.entity_type !== entityType) return false
      if (since != null && activity.created_at <= since) return false
      return true
    })

    const where = ['workspace_id = ?']
    const params: unknown[] = [workspaceId]
    if (types.length === 1) {
      where.push('type = ?')
      params.push(types[0])
    } else if (types.length > 1) {
      where.push(`type IN (${types.map(() => '?').join(',')})`)
      params.push(...types)
    }
    if (actor) {
      where.push('actor = ?')
      params.push(actor)
    }
    if (entityType) {
      where.push('entity_type = ?')
      params.push(entityType)
    }
    if (since != null) {
      where.push('created_at > ?')
      params.push(since)
    }

    let cloudActivities: ActivityRow[] = []
    let cloudTotal = 0
    if (!clientId) {
      cloudActivities = db.prepare(`
        SELECT * FROM activities
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(...params, offset + limit) as ActivityRow[]
      cloudTotal = Number((db.prepare(`
        SELECT COUNT(*) AS total FROM activities WHERE ${where.join(' AND ')}
      `).get(...params) as { total?: number } | undefined)?.total || 0)
    }

    const merged = [
      ...localActivities,
      ...enhanceCloudActivities(db, cloudActivities, workspaceId),
    ].sort((left, right) => Number(right.created_at) - Number(left.created_at) || Number(left.id) - Number(right.id))
    const activities = merged.slice(offset, offset + limit)
    const hasLocalFilters = types.length > 0 || Boolean(actor) || Boolean(entityType) || since != null
    const localTotal = hasLocalFilters
      ? localActivities.length
      : projection.clients
          .filter((client) => !clientId || client.client_id === clientId)
          .reduce((sum, client) => sum + Number(client.total || 0), 0)
    const total = cloudTotal + localTotal

    return NextResponse.json({
      activities,
      total,
      hasMore: offset + activities.length < total,
      authority: projection.clients.length ? 'local_runtime' : 'cloud',
      local_live: projection.clients.length > 0,
      projection_clients: projection.clients,
      projection_errors: projection.errors,
      projection_truncated: projection.clients.some((client) => client.truncated),
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/activities (activities) error')
    return NextResponse.json({ error: 'Failed to fetch activities' }, { status: 500 })
  }
}

async function handleStatsRequest(url: URL, workspaceId: number) {
  try {
    const db = getDatabase()
    const parsedHours = Number.parseInt(url.searchParams.get('hours') || '24', 10)
    const hours = Number.isFinite(parsedHours) ? Math.max(1, Math.min(parsedHours, 24 * 365)) : 24
    const since = Math.floor(Date.now() / 1000) - hours * 3600
    let projection = { activities: [] as ProjectedWorkActivity[], clients: [] as any[], errors: [] as any[] }
    try {
      projection = await getLiveWorkActivityProjection(db, workspaceId)
    } catch (error) {
      logger.warn({ err: error, workspaceId }, 'GET /api/activities stats edge projection unavailable')
    }
    const local = projection.activities.filter((activity) => activity.created_at > since)
    const cloud = db.prepare(`
      SELECT type, actor, created_at FROM activities
      WHERE created_at > ? AND workspace_id = ?
    `).all(since, workspaceId) as Array<{ type: string; actor: string; created_at: number }>
    const combined = [...cloud, ...local]
    const byType = new Map<string, number>()
    const byActor = new Map<string, number>()
    const byHour = new Map<number, number>()
    for (const activity of combined) {
      byType.set(activity.type, (byType.get(activity.type) || 0) + 1)
      byActor.set(activity.actor, (byActor.get(activity.actor) || 0) + 1)
      const bucket = Math.floor(Number(activity.created_at) / 3600) * 3600
      byHour.set(bucket, (byHour.get(bucket) || 0) + 1)
    }
    return NextResponse.json({
      timeframe: `${hours} hours`,
      activityByType: [...byType].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
      topActors: [...byActor].map(([actor, activity_count]) => ({ actor, activity_count }))
        .sort((a, b) => b.activity_count - a.activity_count).slice(0, 10),
      timeline: [...byHour].sort(([left], [right]) => left - right).map(([timestamp, count]) => ({
        timestamp,
        count,
        hour: new Date(timestamp * 1000).toISOString(),
      })),
      authority: projection.clients.length ? 'local_runtime' : 'cloud',
      local_live: projection.clients.length > 0,
      projection_truncated: projection.clients.some((client) => client.truncated),
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/activities (stats) error')
    return NextResponse.json({ error: 'Failed to fetch activity stats' }, { status: 500 })
  }
}
