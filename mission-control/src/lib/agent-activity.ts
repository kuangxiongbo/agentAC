import type Database from 'better-sqlite3'
import {
  resolveAgentQueryIdentity,
  sqlPlaceholders,
  uniqueAgentAliases,
  type AgentQueryIdentity,
} from '@/lib/agent-query-identity'

export interface AgentActivityItem {
  id: string
  type: string
  source: 'activity' | 'task' | 'supervision' | 'mailbox' | 'session' | 'sync'
  status: string | null
  description: string
  created_at: number
  task_id?: number | null
  goal_id?: string | null
  message_id?: string | null
}

export function listAgentActivity(
  db: Database.Database,
  input: { agentId: string; workspaceId: number; limit: number },
): { identity: AgentQueryIdentity; activities: AgentActivityItem[] } | null {
  const identity = resolveAgentQueryIdentity(db, input.agentId, input.workspaceId)
  if (!identity) return null
  const items: AgentActivityItem[] = []
  const aliases = uniqueAgentAliases([...identity.aliases, identity.sessionKey])

  if (aliases.length) {
    const legacy = db.prepare(`
      SELECT id, type, description, created_at
      FROM activities
      WHERE workspace_id = ? AND actor IN (${sqlPlaceholders(aliases)})
      ORDER BY created_at DESC LIMIT ?
    `).all(input.workspaceId, ...aliases, input.limit) as any[]
    items.push(...legacy.map((row) => ({
      id: `activity:${row.id}`,
      type: row.type,
      source: 'activity' as const,
      status: null,
      description: row.description,
      created_at: row.created_at,
    })))
  }

  const taskConditions: string[] = []
  const taskParams: unknown[] = [input.workspaceId]
  if (aliases.length) {
    taskConditions.push(`t.assigned_to IN (${sqlPlaceholders(aliases)})`)
    taskParams.push(...aliases)
  }
  if (identity.clientId && identity.localAgentId != null) {
    taskConditions.push(`(g.client_id = ? AND sgt.assigned_agent_id = ?)`)
    taskParams.push(identity.clientId, String(identity.localAgentId))
  }
  if (taskConditions.length) {
    const tasks = db.prepare(`
      SELECT DISTINCT t.id, t.title, t.status, t.updated_at, sgt.goal_id
      FROM tasks t
      LEFT JOIN supervision_goal_tasks sgt ON sgt.task_id = t.id
      LEFT JOIN supervision_goals g ON g.id = sgt.goal_id AND g.workspace_id = t.workspace_id
      WHERE t.workspace_id = ? AND (${taskConditions.join(' OR ')})
      ORDER BY t.updated_at DESC LIMIT ?
    `).all(...taskParams, input.limit) as any[]
    items.push(...tasks.map((row) => ({
      id: `task:${row.id}:${row.updated_at}`,
      type: 'task_status',
      source: 'task' as const,
      status: row.status,
      description: `Task #${row.id} ${row.title}`,
      created_at: row.updated_at,
      task_id: row.id,
      goal_id: row.goal_id || null,
    })))
  }

  if (identity.clientId && identity.localAgentId != null) {
    const events = db.prepare(`
      SELECT se.id, se.event_type, se.decision, se.reason, se.created_at,
             se.task_id, se.goal_id
      FROM supervision_events se
      JOIN supervision_goal_tasks sgt ON sgt.goal_id = se.goal_id AND sgt.task_id = se.task_id
      JOIN supervision_goals g ON g.id = sgt.goal_id
      WHERE se.workspace_id = ? AND g.client_id = ? AND sgt.assigned_agent_id = ?
      ORDER BY se.created_at DESC LIMIT ?
    `).all(input.workspaceId, identity.clientId, String(identity.localAgentId), input.limit) as any[]
    items.push(...events.map((row) => ({
      id: `supervision:${row.id}`,
      type: row.event_type,
      source: 'supervision' as const,
      status: row.decision || null,
      description: row.reason || row.decision || row.event_type,
      created_at: row.created_at,
      task_id: row.task_id,
      goal_id: row.goal_id,
    })))

    const messages = db.prepare(`
      SELECT id, type, status, last_error_message, created_at, updated_at,
             json_extract(payload_json, '$.task_id') AS task_id,
             json_extract(payload_json, '$.goal_id') AS goal_id
      FROM edge_messages
      WHERE workspace_id = ? AND client_id = ?
        AND CAST(json_extract(agent_ref_json, '$.local_agent_id') AS INTEGER) = ?
      ORDER BY updated_at DESC LIMIT ?
    `).all(input.workspaceId, identity.clientId, identity.localAgentId, input.limit) as any[]
    items.push(...messages.map((row) => ({
      id: `mailbox:${row.id}:${row.updated_at}`,
      type: row.type,
      source: 'mailbox' as const,
      status: row.status,
      description: row.last_error_message || `${row.type} ${row.status}`,
      created_at: row.updated_at || row.created_at,
      task_id: row.task_id == null ? null : Number(row.task_id),
      goal_id: row.goal_id || null,
      message_id: row.id,
    })))

    const messageEvents = db.prepare(`
      SELECT eme.id, eme.message_id, eme.event_type, eme.to_status, eme.created_at,
             em.type, json_extract(em.payload_json, '$.task_id') AS task_id,
             json_extract(em.payload_json, '$.goal_id') AS goal_id
      FROM edge_message_events eme
      JOIN edge_messages em ON em.id = eme.message_id
      WHERE em.workspace_id = ? AND em.client_id = ?
        AND CAST(json_extract(em.agent_ref_json, '$.local_agent_id') AS INTEGER) = ?
      ORDER BY eme.created_at DESC LIMIT ?
    `).all(input.workspaceId, identity.clientId, identity.localAgentId, input.limit) as any[]
    items.push(...messageEvents.map((row) => ({
      id: `mailbox-event:${row.id}`,
      type: row.event_type,
      source: 'mailbox' as const,
      status: row.to_status || null,
      description: `${row.type} ${row.event_type}`,
      created_at: row.created_at,
      task_id: row.task_id == null ? null : Number(row.task_id),
      goal_id: row.goal_id || null,
      message_id: row.message_id,
    })))
  }

  if (identity.clientId && identity.sessionKey) {
    const session = db.prepare(`
      SELECT session_kind, model, active, last_activity, updated_at
      FROM sync_sessions
      WHERE client_id = ? AND (session_id = ? OR session_key = ?)
      ORDER BY updated_at DESC LIMIT 1
    `).get(identity.clientId, identity.sessionKey, identity.sessionKey) as any
    if (session) {
      const timestamp = session.last_activity || session.updated_at
      items.push({
        id: `session:${identity.clientId}:${identity.sessionKey}:${timestamp}`,
        type: 'session_activity',
        source: 'session',
        status: session.active ? 'active' : 'inactive',
        description: `Session execution ${session.session_kind}${session.model ? ` (${session.model})` : ''}`,
        created_at: timestamp,
      })
    }
  }

  if (identity.syncIndexId != null) {
    const sync = db.prepare(`SELECT status, updated_at FROM sync_agent_index WHERE id = ?`).get(identity.syncIndexId) as any
    if (sync) items.push({
      id: `sync:${identity.syncIndexId}:${sync.updated_at}`,
      type: 'agent_synced',
      source: 'sync',
      status: sync.status,
      description: `Agent inventory synchronized (${sync.status})`,
      created_at: sync.updated_at,
    })
  }

  items.sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
  return { identity, activities: items.slice(0, input.limit) }
}
