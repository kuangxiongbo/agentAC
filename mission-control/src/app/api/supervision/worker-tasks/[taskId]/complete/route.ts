import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getDatabase } from '@/lib/db'
import { mutationLimiter } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

const OUTCOMES = new Set(['success', 'failed', 'partial'])

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  const { taskId: rawTaskId } = await params
  const taskId = Number(rawTaskId)
  if (!Number.isInteger(taskId) || taskId < 1) {
    return NextResponse.json({ error: 'Invalid task ID' }, { status: 400 })
  }

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const goalId = String(body.goal_id || '').trim()
  const workerLocalAgentId = Number(body.worker_local_agent_id)
  const workerSessionId = String(body.worker_session_id || '').trim()
  const outcome = String(body.outcome || 'success').trim()
  const resolution = String(body.resolution || '').trim()
  const evidence = body.evidence && typeof body.evidence === 'object' && !Array.isArray(body.evidence)
    ? body.evidence as Record<string, unknown>
    : {}
  if (!goalId || !Number.isInteger(workerLocalAgentId) || workerLocalAgentId < 1) {
    return NextResponse.json({ error: 'goal_id and worker_local_agent_id are required' }, { status: 400 })
  }
  if (!OUTCOMES.has(outcome)) {
    return NextResponse.json({ error: 'outcome must be success, failed, or partial' }, { status: 400 })
  }
  if (!resolution || resolution.length > 100_000) {
    return NextResponse.json({ error: 'resolution is required and must not exceed 100000 characters' }, { status: 400 })
  }

  const db = getDatabase()
  const workspaceId = auth.user.workspace_id ?? 1
  const row = db.prepare(`
    SELECT g.tenant_id, g.status AS goal_status, sgt.assigned_agent_id,
           sgt.assigned_session_id, t.status, t.outcome, t.resolution
    FROM supervision_goal_tasks sgt
    JOIN supervision_goals g ON g.id = sgt.goal_id AND g.workspace_id = ?
    JOIN tasks t ON t.id = sgt.task_id AND t.workspace_id = ?
    WHERE sgt.goal_id = ? AND sgt.task_id = ?
    LIMIT 1
  `).get(workspaceId, workspaceId, goalId, taskId) as {
    tenant_id: number | null
    goal_status: string
    assigned_agent_id: string | null
    assigned_session_id: string | null
    status: string
    outcome: string | null
    resolution: string | null
  } | undefined

  if (!row || (auth.user.tenant_id != null && row.tenant_id !== auth.user.tenant_id)) {
    return NextResponse.json({ error: 'Supervised task not found' }, { status: 404 })
  }
  if (Number(row.assigned_agent_id) !== workerLocalAgentId) {
    return NextResponse.json({ error: 'Worker is not assigned to this supervised task' }, { status: 403 })
  }
  if (row.assigned_session_id && workerSessionId !== row.assigned_session_id) {
    return NextResponse.json({ error: 'Worker session does not match the supervised task assignment' }, { status: 403 })
  }
  if (row.status === 'done') {
    return NextResponse.json({
      ok: true,
      idempotent: true,
      task: { id: taskId, status: row.status, outcome: row.outcome, resolution: row.resolution },
    })
  }
  if (row.goal_status !== 'running' || row.status !== 'in_progress') {
    return NextResponse.json({ error: `Task cannot be completed from ${row.status}` }, { status: 409 })
  }

  const now = Math.floor(Date.now() / 1000)
  db.transaction(() => {
    const updated = db.prepare(`
      UPDATE tasks
      SET status = 'done', outcome = ?, resolution = ?,
          error_message = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND status = 'in_progress'
    `).run(
      outcome,
      resolution,
      outcome === 'failed' ? resolution.slice(0, 5000) : null,
      now,
      now,
      taskId,
      workspaceId,
    )
    if (updated.changes !== 1) throw new Error('TASK_STATE_CONFLICT')
    db.prepare(`
      UPDATE supervision_goal_tasks SET updated_at = unixepoch()
      WHERE goal_id = ? AND task_id = ?
    `).run(goalId, taskId)
    db.prepare(`
      INSERT OR IGNORE INTO supervision_events (
        workspace_id, tenant_id, goal_id, task_id, event_type, actor_type,
        actor_id, decision, reason, evidence_json, action_json,
        correlation_id, idempotency_key, created_at
      ) VALUES (?, ?, ?, ?, 'goal_task_worker_completed', 'worker_agent', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      workspaceId,
      row.tenant_id,
      goalId,
      taskId,
      String(workerLocalAgentId),
      outcome,
      resolution.slice(0, 5000),
      JSON.stringify(evidence),
      JSON.stringify({ worker_local_agent_id: workerLocalAgentId, worker_session_id: workerSessionId || null }),
      `goal:${goalId}:task:${taskId}:worker-complete`,
      `goal:${goalId}:task:${taskId}:worker-completed`,
      now,
    )
  })()

  return NextResponse.json({
    ok: true,
    idempotent: false,
    task: { id: taskId, status: 'done', outcome, resolution },
    next_step: 'The supervision monitor will activate dependency-ready successor tasks automatically.',
  })
}
