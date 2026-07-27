import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getDatabase } from '@/lib/db'
import { heavyLimiter } from '@/lib/rate-limit'
import { getConnectedBridgeClients, requestBridgeClientWorkSearch } from '@/lib/bridge-server'
import { getLiveWorkTaskProjection, projectedWorkTaskId } from '@/lib/work-task-projection'
import { getLiveWorkActivityProjection, projectedWorkActivityId } from '@/lib/work-activity-projection'

interface SearchResult {
  type: 'task' | 'agent' | 'activity' | 'audit' | 'message' | 'notification' | 'webhook' | 'pipeline'
  id: number
  title: string
  subtitle?: string
  excerpt?: string
  created_at: number
  relevance: number
  source?: 'cloud_control' | 'local_runtime' | 'local_snapshot'
  authority?: 'cloud' | 'local_runtime' | 'local_snapshot'
  stale?: boolean
  snapshot_at?: number
  client_id?: string
  local_entity_id?: string | number
  agent_name?: string
  original_agent_name?: string
}

/**
 * GET /api/search?q=<query>&type=<optional type filter>&limit=<optional>
 * Global search across all MC entities.
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = heavyLimiter(request)
  if (rateCheck) return rateCheck

  const { searchParams } = new URL(request.url)
  const query = searchParams.get('q')?.trim()
  const typeFilter = searchParams.get('type')
  const limit = Math.min(parseInt(searchParams.get('limit') || '30'), 100)

  if (!query || query.length < 2) {
    return NextResponse.json({ error: 'Query must be at least 2 characters' }, { status: 400 })
  }

  const db = getDatabase()
  const workspaceId = auth.user.workspace_id ?? 1
  const likeQ = `%${query}%`
  const results: SearchResult[] = []

  // Search tasks
  if (!typeFilter || typeFilter === 'task') {
    try {
      const tasks = db.prepare(`
        SELECT id, title, description, status, assigned_to, created_at
        FROM tasks WHERE workspace_id = ? AND (title LIKE ? OR description LIKE ? OR assigned_to LIKE ?)
        ORDER BY created_at DESC LIMIT ?
      `).all(workspaceId, likeQ, likeQ, likeQ, limit) as any[]
      for (const t of tasks) {
        results.push({
          type: 'task',
          id: t.id,
          title: t.title,
          subtitle: `${t.status} ${t.assigned_to ? `· ${t.assigned_to}` : ''}`,
          excerpt: truncateMatch(t.description, query),
          created_at: t.created_at,
          relevance: t.title.toLowerCase().includes(query.toLowerCase()) ? 2 : 1,
        })
      }
    } catch { /* table might not exist */ }
  }

  // Search agents
  if (!typeFilter || typeFilter === 'agent') {
    try {
      const agents = db.prepare(`
        SELECT id, name, role, status, last_activity, created_at
        FROM agents WHERE workspace_id = ? AND (name LIKE ? OR role LIKE ? OR last_activity LIKE ?)
        ORDER BY created_at DESC LIMIT ?
      `).all(workspaceId, likeQ, likeQ, likeQ, limit) as any[]
      for (const a of agents) {
        results.push({
          type: 'agent',
          id: a.id,
          title: a.name,
          subtitle: `${a.role} · ${a.status}`,
          excerpt: a.last_activity,
          created_at: a.created_at,
          relevance: a.name.toLowerCase().includes(query.toLowerCase()) ? 2 : 1,
        })
      }
    } catch { /* table might not exist */ }
  }

  // Search activities
  if (!typeFilter || typeFilter === 'activity') {
    try {
      const activities = db.prepare(`
        SELECT id, type, actor, description, created_at
        FROM activities WHERE workspace_id = ? AND (description LIKE ? OR actor LIKE ?)
        ORDER BY created_at DESC LIMIT ?
      `).all(workspaceId, likeQ, likeQ, limit) as any[]
      for (const a of activities) {
        results.push({
          type: 'activity',
          id: a.id,
          title: a.description,
          subtitle: `by ${a.actor}`,
          created_at: a.created_at,
          relevance: 1,
        })
      }
    } catch { /* table might not exist */ }
  }

  // Search only the current workspace audit stream.
  if ((!typeFilter || typeFilter === 'audit') && auth.user.role === 'admin') {
    try {
      const audits = db.prepare(`
        SELECT id, action, actor, detail, created_at
        FROM audit_log WHERE workspace_id = ? AND (action LIKE ? OR actor LIKE ? OR detail LIKE ?)
        ORDER BY created_at DESC LIMIT ?
      `).all(workspaceId, likeQ, likeQ, likeQ, limit) as any[]
      for (const a of audits) {
        results.push({
          type: 'audit',
          id: a.id,
          title: a.action,
          subtitle: `by ${a.actor}`,
          excerpt: truncateMatch(a.detail, query),
          created_at: a.created_at,
          relevance: 1,
        })
      }
    } catch { /* table might not exist */ }
  }

  // Search messages
  if (!typeFilter || typeFilter === 'message') {
    try {
      const messages = db.prepare(`
        SELECT id, from_agent, to_agent, content, conversation_id, created_at
        FROM messages WHERE workspace_id = ? AND (content LIKE ? OR from_agent LIKE ?)
        ORDER BY created_at DESC LIMIT ?
      `).all(workspaceId, likeQ, likeQ, limit) as any[]
      for (const m of messages) {
        results.push({
          type: 'message',
          id: m.id,
          title: `${m.from_agent} → ${m.to_agent || 'all'}`,
          subtitle: m.conversation_id,
          excerpt: truncateMatch(m.content, query),
          created_at: m.created_at,
          relevance: 1,
        })
      }
    } catch { /* table might not exist */ }
  }

  // Search webhooks
  if (!typeFilter || typeFilter === 'webhook') {
    try {
      const webhooks = db.prepare(`
        SELECT id, name, url, events, created_at
        FROM webhooks WHERE workspace_id = ? AND (name LIKE ? OR url LIKE ?)
        ORDER BY created_at DESC LIMIT ?
      `).all(workspaceId, likeQ, likeQ, limit) as any[]
      for (const w of webhooks) {
        results.push({
          type: 'webhook',
          id: w.id,
          title: w.name,
          subtitle: w.url,
          created_at: w.created_at,
          relevance: w.name.toLowerCase().includes(query.toLowerCase()) ? 2 : 1,
        })
      }
    } catch { /* table might not exist */ }
  }

  // Search pipelines
  if (!typeFilter || typeFilter === 'pipeline') {
    try {
      const pipelines = db.prepare(`
        SELECT id, name, description, created_at
        FROM workflow_pipelines WHERE workspace_id = ? AND (name LIKE ? OR description LIKE ?)
        ORDER BY created_at DESC LIMIT ?
      `).all(workspaceId, likeQ, likeQ, limit) as any[]
      for (const p of pipelines) {
        results.push({
          type: 'pipeline',
          id: p.id,
          title: p.name,
          excerpt: truncateMatch(p.description, query),
          created_at: p.created_at,
          relevance: p.name.toLowerCase().includes(query.toLowerCase()) ? 2 : 1,
        })
      }
    } catch { /* table might not exist */ }
  }

  // Sort by relevance then recency
  const allowedClients = new Set(
    (db.prepare('SELECT client_id FROM sync_clients WHERE workspace_id = ?').all(workspaceId) as Array<{ client_id: string }>).map((row) => row.client_id),
  )
  const localTypes = typeFilter && ['task', 'activity'].includes(typeFilter) ? [typeFilter] : typeFilter ? [] : ['task', 'activity']
  const connected = localTypes.length > 0
    ? getConnectedBridgeClients('work_search').filter((client) => allowedClients.has(client.clientId))
    : []
  const remote = await Promise.allSettled(connected.map(async (client) => ({
    client,
    response: await requestBridgeClientWorkSearch({ clientId: client.clientId, query, types: localTypes, limit }),
  })))
  const localErrors: Array<{ client_id: string; error: string }> = []
  const liveSearchClients = new Set<string>()
  remote.forEach((item, index) => {
    const client = connected[index]
    if (item.status === 'rejected') {
      localErrors.push({ client_id: client.clientId, error: item.reason instanceof Error ? item.reason.message : String(item.reason) })
      return
    }
    liveSearchClients.add(client.clientId)
    for (const row of item.value.response.results) {
      const type = row.type === 'task' ? 'task' : row.type === 'activity' ? 'activity' : null
      const localId = String(row.local_id ?? '').trim()
      if (!type || !localId) continue
      const originalAgentName = typeof row.agent_name === 'string' ? row.agent_name : ''
      const mapped = originalAgentName ? db.prepare(`SELECT remote_name FROM sync_agent_index WHERE client_id = ? AND original_name = ? COLLATE NOCASE LIMIT 1`).get(client.clientId, originalAgentName) as any : null
      results.push({
        type,
        id: type === 'task' ? projectedWorkTaskId(client.clientId, Number(localId)) : projectedWorkActivityId(client.clientId, localId),
        title: String(row.title || ''), subtitle: typeof row.subtitle === 'string' ? row.subtitle : undefined,
        excerpt: typeof row.excerpt === 'string' ? row.excerpt : undefined,
        created_at: Number(row.created_at || 0), relevance: Number(row.relevance || 1),
        source: 'local_runtime', authority: 'local_runtime', client_id: client.clientId,
        local_entity_id: /^\d+$/.test(localId) ? Number(localId) : localId,
        agent_name: mapped?.remote_name || (originalAgentName ? `${client.clientId}-${originalAgentName}` : undefined),
        original_agent_name: originalAgentName || undefined,
      })
    }
  })
  const [taskProjection, activityProjection] = await Promise.all([
    localTypes.includes('task') ? getLiveWorkTaskProjection(db, workspaceId).catch(() => null) : Promise.resolve(null),
    localTypes.includes('activity') ? getLiveWorkActivityProjection(db, workspaceId).catch(() => null) : Promise.resolve(null),
  ])
  const lowerQuery = query.toLowerCase()
  for (const task of taskProjection?.tasks || []) {
    if (liveSearchClients.has(task.client_id)) continue
    const haystack = `${String(task.title || '')}\n${String(task.description || '')}\n${String(task.assigned_to || '')}`.toLowerCase()
    if (!haystack.includes(lowerQuery)) continue
    const originalAgentName = String(task.assigned_to || '')
    const mapped = originalAgentName ? db.prepare(`SELECT remote_name FROM sync_agent_index WHERE client_id = ? AND original_name = ? COLLATE NOCASE LIMIT 1`).get(task.client_id, originalAgentName) as any : null
    results.push({
      type: 'task', id: task.id, title: String(task.title || ''),
      subtitle: `${String(task.status || 'inbox')} ${originalAgentName ? `· ${originalAgentName}` : ''}`,
      excerpt: truncateMatch(String(task.description || ''), query), created_at: Number(task.created_at || 0),
      relevance: String(task.title || '').toLowerCase().includes(lowerQuery) ? 2 : 1,
      source: task.source, authority: task.authority, stale: task.stale, snapshot_at: task.snapshot_at,
      client_id: task.client_id, local_entity_id: task.local_task_id,
      agent_name: mapped?.remote_name || (originalAgentName ? `${task.client_id}-${originalAgentName}` : undefined),
      original_agent_name: originalAgentName || undefined,
    })
  }
  for (const activity of activityProjection?.activities || []) {
    if (liveSearchClients.has(activity.client_id)) continue
    const haystack = `${activity.description}\n${activity.actor}`.toLowerCase()
    if (!haystack.includes(lowerQuery)) continue
    const mapped = activity.actor ? db.prepare(`SELECT remote_name FROM sync_agent_index WHERE client_id = ? AND original_name = ? COLLATE NOCASE LIMIT 1`).get(activity.client_id, activity.actor) as any : null
    results.push({
      type: 'activity', id: activity.id, title: activity.description, subtitle: `by ${activity.actor}`,
      created_at: activity.created_at, relevance: 1, source: activity.source, authority: activity.authority,
      stale: activity.stale, snapshot_at: activity.snapshot_at, client_id: activity.client_id,
      local_entity_id: activity.local_activity_id, agent_name: mapped?.remote_name || `${activity.client_id}-${activity.actor}`,
      original_agent_name: activity.actor,
    })
  }
  for (const result of results) {
    if (!result.source) { result.source = 'cloud_control'; result.authority = 'cloud' }
  }
  results.sort((a, b) => b.relevance - a.relevance || b.created_at - a.created_at)

  return NextResponse.json({
    query,
    count: results.length,
    results: results.slice(0, limit),
    authority: liveSearchClients.size > 0 ? 'combined' : results.some((result) => result.source === 'local_snapshot') ? 'local_snapshot' : 'cloud',
    local_live: liveSearchClients.size > 0,
    local_stale: results.some((result) => result.source === 'local_snapshot'),
    local_errors: localErrors,
  })
}

function truncateMatch(text: string | null, query: string, maxLen = 120): string | undefined {
  if (!text) return undefined
  const lower = text.toLowerCase()
  const idx = lower.indexOf(query.toLowerCase())
  if (idx === -1) return text.slice(0, maxLen) + (text.length > maxLen ? '...' : '')
  const start = Math.max(0, idx - 40)
  const end = Math.min(text.length, idx + query.length + 80)
  const excerpt = (start > 0 ? '...' : '') + text.slice(start, end) + (end < text.length ? '...' : '')
  return excerpt
}
