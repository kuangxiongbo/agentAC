import type Database from 'better-sqlite3'
import { getDatabase } from './db'

export interface HumanWatchHealthSummary {
  status: 'disabled' | 'idle' | 'healthy' | 'degraded'
  generated_at: number
  window_seconds: number
  bindings: {
    enabled: number
    with_session_kind: number
  }
  interventions: {
    attempts: number
    completed_success: number
    completed_failed: number
    judge_failed: number
    bridge_offline: number
    no_session_kind: number
    rate_limited: number
    decision_success_rate: number | null
    last_success_at: number | null
    top_skip_reasons: Array<{ reason: string; count: number }>
  }
  reliable_messages: {
    total: number
    completed: number
    failed: number
    pending: number
    dead_letter: number
    completion_rate: number | null
    average_completion_seconds: number | null
    max_completion_seconds: number | null
  }
}

type CountRow = { count: number }

function count(
  db: Database.Database,
  sql: string,
  params: Array<string | number | null>,
): number {
  return (db.prepare(sql).get(...params) as CountRow | undefined)?.count ?? 0
}

function rate(success: number, total: number): number | null {
  if (total <= 0) return null
  return Math.round((success / total) * 10_000) / 10_000
}

export function getHumanWatchHealthSummary(input: {
  workspaceId: number
  tenantId?: number | null
  windowSeconds?: number
}, database?: Database.Database): HumanWatchHealthSummary {
  const db = database ?? getDatabase()
  const now = Math.floor(Date.now() / 1000)
  const windowSeconds = Math.min(Math.max(input.windowSeconds ?? 7 * 86400, 3600), 30 * 86400)
  const since = now - windowSeconds
  const tenantId = input.tenantId ?? null
  const tenantFilter = tenantId == null ? '' : ' AND tenant_id = ?'
  const baseParams = tenantId == null
    ? [input.workspaceId]
    : [input.workspaceId, tenantId]

  const enabled = count(
    db,
    `SELECT COUNT(*) AS count FROM human_watch_bindings
     WHERE workspace_id = ?${tenantFilter} AND enabled = 1`,
    baseParams,
  )
  const withSessionKind = count(
    db,
    `SELECT COUNT(*) AS count FROM human_watch_bindings
     WHERE workspace_id = ?${tenantFilter} AND enabled = 1
       AND worker_session_kind IS NOT NULL AND worker_session_kind <> ''`,
    baseParams,
  )

  const eventParams = tenantId == null
    ? [input.workspaceId, since]
    : [input.workspaceId, tenantId, since]
  const eventTenantFilter = tenantId == null ? '' : ' AND i.tenant_id = ?'
  const eventBase = `
    FROM human_watch_interventions i
    INNER JOIN human_watch_bindings b
      ON b.id = i.binding_id
      AND b.workspace_id = i.workspace_id
      AND b.enabled = 1
    WHERE i.workspace_id = ?${eventTenantFilter} AND i.created_at >= ?
  `
  const eventCount = (where: string) => count(
    db,
    `SELECT COUNT(*) AS count ${eventBase} AND ${where}`,
    eventParams,
  )

  const attempts = eventCount(`i.event_type = 'intervention_attempt'`)
  const completedSuccess = eventCount(
    `i.event_type = 'intervention_completed' AND i.outcome = 'success'`,
  )
  const completedFailed = eventCount(
    `i.event_type = 'intervention_completed' AND i.outcome = 'failed'`,
  )
  const judgeFailed = eventCount(`i.skip_reason = 'steward_judge_failed'`)
  const bridgeOffline = eventCount(`i.skip_reason = 'bridge_offline'`)
  const noSessionKind = eventCount(`i.skip_reason = 'no_session_kind'`)
  const rateLimited = eventCount(`i.skip_reason = 'rate_limited'`)

  const skipReasons = db.prepare(`
    SELECT i.skip_reason AS reason, COUNT(*) AS count
    ${eventBase}
      AND i.skip_reason IS NOT NULL AND i.skip_reason <> ''
    GROUP BY i.skip_reason
    ORDER BY count DESC, reason ASC
    LIMIT 8
  `).all(...eventParams) as Array<{ reason: string; count: number }>

  const lastSuccessParams = tenantId == null
    ? [input.workspaceId]
    : [input.workspaceId, tenantId]
  const lastSuccess = db.prepare(`
    SELECT MAX(i.created_at) AS created_at
    FROM human_watch_interventions i
    INNER JOIN human_watch_bindings b
      ON b.id = i.binding_id
      AND b.workspace_id = i.workspace_id
      AND b.enabled = 1
    WHERE i.workspace_id = ?${eventTenantFilter}
      AND i.event_type = 'intervention_completed'
      AND i.outcome = 'success'
  `).get(...lastSuccessParams) as { created_at: number | null } | undefined

  const messageParams = tenantId == null
    ? [input.workspaceId, since]
    : [input.workspaceId, tenantId, since]
  const messageTenantFilter = tenantId == null ? '' : ' AND em.tenant_id = ?'
  const messageRows = db.prepare(`
    SELECT
      em.status,
      COUNT(*) AS count,
      AVG(CASE WHEN em.completed_at IS NOT NULL THEN em.completed_at - em.created_at END) AS avg_seconds,
      MAX(CASE WHEN em.completed_at IS NOT NULL THEN em.completed_at - em.created_at END) AS max_seconds
    FROM edge_messages em
    WHERE em.workspace_id = ?${messageTenantFilter}
      AND em.created_at >= ?
      AND em.type = 'human_watch.assist.requested'
      AND json_valid(em.payload_json) = 1
      AND CAST(json_extract(em.payload_json, '$.binding_id') AS INTEGER) IN (
        SELECT id FROM human_watch_bindings
        WHERE workspace_id = em.workspace_id AND enabled = 1
      )
    GROUP BY em.status
  `).all(...messageParams) as Array<{
    status: string
    count: number
    avg_seconds: number | null
    max_seconds: number | null
  }>

  const messageCounts = new Map(messageRows.map((row) => [row.status, row.count]))
  const completedRow = messageRows.find((row) => row.status === 'completed')
  const totalMessages = messageRows.reduce((sum, row) => sum + row.count, 0)
  const completedMessages = messageCounts.get('completed') ?? 0
  const failedMessages =
    (messageCounts.get('failed') ?? 0) +
    (messageCounts.get('cancelled') ?? 0)
  const pendingMessages =
    (messageCounts.get('pending') ?? 0) +
    (messageCounts.get('leased') ?? 0)
  const deadLetterMessages = messageCounts.get('dead_letter') ?? 0

  const decisionFailures = completedFailed + judgeFailed + bridgeOffline + noSessionKind
  let status: HumanWatchHealthSummary['status'] = 'healthy'
  if (enabled === 0) status = 'disabled'
  else if (attempts === 0 && decisionFailures === 0 && totalMessages === 0) status = 'idle'
  else if (decisionFailures > 0 || failedMessages > 0 || deadLetterMessages > 0) status = 'degraded'

  return {
    status,
    generated_at: now,
    window_seconds: windowSeconds,
    bindings: {
      enabled,
      with_session_kind: withSessionKind,
    },
    interventions: {
      attempts,
      completed_success: completedSuccess,
      completed_failed: completedFailed,
      judge_failed: judgeFailed,
      bridge_offline: bridgeOffline,
      no_session_kind: noSessionKind,
      rate_limited: rateLimited,
      decision_success_rate: rate(completedSuccess, completedSuccess + decisionFailures),
      last_success_at: lastSuccess?.created_at ?? null,
      top_skip_reasons: skipReasons,
    },
    reliable_messages: {
      total: totalMessages,
      completed: completedMessages,
      failed: failedMessages,
      pending: pendingMessages,
      dead_letter: deadLetterMessages,
      completion_rate: rate(completedMessages, totalMessages),
      average_completion_seconds: completedRow?.avg_seconds == null
        ? null
        : Math.round(completedRow.avg_seconds * 100) / 100,
      max_completion_seconds: completedRow?.max_seconds ?? null,
    },
  }
}
