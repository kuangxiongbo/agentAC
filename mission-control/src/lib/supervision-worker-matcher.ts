import type Database from 'better-sqlite3'
import { isBridgeClientOnline } from './bridge-server'
import { getDatabase } from './db'
import { getSupervisionGoal } from './supervision-goals'
import type { SupervisionPlanTask } from './supervision-plans'

const SUPPORTED_FRAMEWORKS = new Set(['claude-code', 'codex-cli', 'hermes'])
const UNAVAILABLE_STATUSES = new Set(['error', 'disabled'])

interface AgentConfig {
  capabilities: string[]
  highRiskAllowed: boolean
  projectIds: number[]
}

interface IndexedWorkerRow {
  client_id: string
  client_name: string
  local_agent_id: number
  original_name: string
  remote_name: string
  role: string
  status: string
  framework: string | null
  session_key: string | null
  updated_at: number
}

interface MirroredAgentRow {
  id: number
  name: string
  node_id: string | null
  config: string | null
}

export interface SupervisionWorkerCandidate {
  agent_id: number | null
  local_agent_id: number
  client_id: string
  client_name: string
  name: string
  assignment_name: string
  role: string
  framework: 'claude-code' | 'codex-cli' | 'hermes'
  session_id: string
  status: string
  capabilities: string[]
  active_tasks: number
  recent_success_rate: number | null
  score: number
  reasons: string[]
}

export interface SupervisionWorkerMatchResult {
  selected: SupervisionWorkerCandidate | null
  candidates: SupervisionWorkerCandidate[]
  rejected: Array<{
    client_id: string
    local_agent_id: number
    name: string
    reason: string
  }>
}

export interface MatchSupervisionWorkerInput {
  goalId: string
  workspaceId: number
  task: SupervisionPlanTask
  allowedClientIds?: string[]
  excludedWorkerIds?: number[]
  maxActiveTasks?: number
  projectId?: number | null
}

interface MatcherDependencies {
  isClientOnline?: (clientId: string) => boolean
  nowSeconds?: number
}

function normalizeFramework(framework: string | null): string {
  const value = String(framework || '').trim().toLowerCase()
  if (value === 'claude' || value === 'claude-sdk') return 'claude-code'
  if (value === 'codex' || value === 'openai') return 'codex-cli'
  return value
}

function normalizeLabels(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return [...new Set(values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean))]
}

function parseAgentConfig(raw: string | null): AgentConfig {
  if (!raw) return { capabilities: [], highRiskAllowed: false, projectIds: [] }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const supervision = parsed.supervision && typeof parsed.supervision === 'object'
      ? parsed.supervision as Record<string, unknown>
      : {}
    const rawProjects = Array.isArray(parsed.project_ids) ? parsed.project_ids : []
    return {
      capabilities: normalizeLabels(parsed.capabilities),
      highRiskAllowed: parsed.high_risk_allowed === true || supervision.high_risk_allowed === true,
      projectIds: rawProjects
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0),
    }
  } catch {
    return { capabilities: [], highRiskAllowed: false, projectIds: [] }
  }
}

function findMirror(
  row: IndexedWorkerRow,
  mirrors: MirroredAgentRow[],
): { row: MirroredAgentRow | null; config: AgentConfig } {
  for (const mirror of mirrors) {
    if (mirror.node_id !== row.client_id) continue
    let parsed: Record<string, unknown> = {}
    try {
      parsed = mirror.config ? JSON.parse(mirror.config) as Record<string, unknown> : {}
    } catch {
      parsed = {}
    }
    const localId = Number(parsed.local_agent_id)
    const originalName = String(parsed.original_name || '').trim().toLowerCase()
    if (
      (Number.isFinite(localId) && localId === row.local_agent_id)
      || (originalName && originalName === row.original_name.toLowerCase())
      || mirror.name === row.remote_name
    ) {
      return { row: mirror, config: parseAgentConfig(mirror.config) }
    }
  }
  return { row: null, config: { capabilities: [], highRiskAllowed: false, projectIds: [] } }
}

function defaultClientOnline(): (clientId: string) => boolean {
  // Supervision dispatch requires a live WebSocket to deliver the reliable
  // mailbox message. A recent sync heartbeat can outlive a dropped socket.
  return (clientId) => isBridgeClientOnline(clientId)
}

export function matchSupervisionWorker(
  input: MatchSupervisionWorkerInput,
  dependencies: MatcherDependencies = {},
  database?: Database.Database,
): SupervisionWorkerMatchResult {
  const db = database ?? getDatabase()
  const goal = getSupervisionGoal(input.goalId, input.workspaceId, db)
  if (!goal) throw new Error('Goal not found')

  const allowedClientIds = new Set(input.allowedClientIds?.length ? input.allowedClientIds : [goal.client_id])
  const allowedWorkerIds = new Set(goal.allowed_worker_ids)
  const excludedWorkerIds = new Set(input.excludedWorkerIds ?? [])
  const maxActiveTasks = Math.max(1, input.maxActiveTasks ?? 3)
  const isClientOnline = dependencies.isClientOnline ?? defaultClientOnline()
  const now = dependencies.nowSeconds ?? Math.floor(Date.now() / 1000)

  const indexed = db.prepare(`
    SELECT client_id, client_name, local_agent_id, original_name, remote_name,
           role, status, framework, session_key, updated_at
    FROM sync_agent_index
    WHERE client_id IN (${[...allowedClientIds].map(() => '?').join(',')})
    ORDER BY client_id, local_agent_id
  `).all(...allowedClientIds) as IndexedWorkerRow[]
  const mirrors = db.prepare(`
    SELECT id, name, node_id, config
    FROM agents
    WHERE workspace_id = ? AND hidden = 0
  `).all(input.workspaceId) as MirroredAgentRow[]
  const taskRows = db.prepare(`
    SELECT assigned_to, status, outcome, project_id, metadata
    FROM tasks
    WHERE workspace_id = ? AND assigned_to IS NOT NULL
  `).all(input.workspaceId) as Array<{
    assigned_to: string
    status: string
    outcome: string | null
    project_id: number | null
    metadata: string | null
  }>

  const candidates: SupervisionWorkerCandidate[] = []
  const rejected: SupervisionWorkerMatchResult['rejected'] = []
  const reject = (row: IndexedWorkerRow, reason: string) => rejected.push({
    client_id: row.client_id,
    local_agent_id: row.local_agent_id,
    name: row.original_name,
    reason,
  })

  for (const row of indexed) {
    if (row.role.trim().toLowerCase() === 'human-watch') {
      reject(row, 'human_watch_not_executable')
      continue
    }
    if (allowedWorkerIds.size > 0 && !allowedWorkerIds.has(row.local_agent_id)) {
      reject(row, 'not_in_goal_allowlist')
      continue
    }
    if (excludedWorkerIds.has(row.local_agent_id)) {
      reject(row, 'worker_excluded')
      continue
    }
    if (!isClientOnline(row.client_id)) {
      reject(row, 'client_offline')
      continue
    }
    if (UNAVAILABLE_STATUSES.has(row.status.trim().toLowerCase())) {
      reject(row, 'worker_unavailable')
      continue
    }
    if (!row.session_key?.trim()) {
      reject(row, 'worker_session_missing')
      continue
    }
    const framework = normalizeFramework(row.framework)
    if (!SUPPORTED_FRAMEWORKS.has(framework)) {
      reject(row, 'framework_not_supported')
      continue
    }

    const mirror = findMirror(row, mirrors)
    if ((input.task.risk === 'high' || input.task.risk === 'critical') && !mirror.config.highRiskAllowed) {
      reject(row, 'high_risk_not_authorized')
      continue
    }
    const aliases = new Set([row.original_name, row.remote_name, mirror.row?.name].filter(Boolean) as string[])
    const workerTasks = taskRows.filter((task) => {
      if (aliases.has(task.assigned_to)) return true
      try {
        const metadata = task.metadata ? JSON.parse(task.metadata) as Record<string, unknown> : {}
        return String(metadata.target_session || '') === row.session_key
          && String(metadata.worker_client_id || '') === row.client_id
      } catch {
        return false
      }
    })
    const activeTasks = workerTasks.filter((task) => ['assigned', 'in_progress', 'review', 'quality_review'].includes(task.status)).length
    if (activeTasks >= maxActiveTasks) {
      reject(row, 'worker_at_capacity')
      continue
    }

    const completed = workerTasks.filter((task) => task.outcome === 'success' || task.outcome === 'failed')
    const successes = completed.filter((task) => task.outcome === 'success').length
    const recentSuccessRate = completed.length > 0 ? successes / completed.length : null
    const required = normalizeLabels(input.task.required_capabilities)
    const matchedCapabilities = required.filter((capability) => mirror.config.capabilities.includes(capability))
    const capabilityRatio = required.length > 0 ? matchedCapabilities.length / required.length : 1

    let score = 30
    const reasons = ['eligible executable worker']
    const normalizedStatus = row.status.trim().toLowerCase()
    if (normalizedStatus === 'offline' || normalizedStatus === 'sleeping') {
      score -= 10
      reasons.push('resumable ' + normalizedStatus + ' session')
    }
    if (now - row.updated_at > 5 * 60) {
      score -= 5
      reasons.push('agent index stale; live bridge is authoritative')
    }
    score += Math.round(capabilityRatio * 35)
    reasons.push(required.length > 0
      ? `capabilities ${matchedCapabilities.length}/${required.length}`
      : 'no required capabilities')
    if (input.task.preferred_framework === framework) {
      score += 12
      reasons.push(`preferred framework ${framework}`)
    }
    const loadScore = Math.max(0, 15 - activeTasks * 5)
    score += loadScore
    reasons.push(`active load ${activeTasks}/${maxActiveTasks}`)
    if (recentSuccessRate != null) {
      score += Math.round(recentSuccessRate * 8)
      reasons.push(`recent success ${Math.round(recentSuccessRate * 100)}%`)
    }
    if (input.projectId && mirror.config.projectIds.includes(input.projectId)) {
      score += 5
      reasons.push('same project experience')
    }
    if (row.client_id === goal.client_id) {
      score += 5
      reasons.push('goal data locality')
    }

    candidates.push({
      agent_id: mirror.row?.id ?? null,
      local_agent_id: row.local_agent_id,
      client_id: row.client_id,
      client_name: row.client_name,
      name: row.original_name,
      assignment_name: mirror.row?.name ?? row.remote_name,
      role: row.role,
      framework: framework as SupervisionWorkerCandidate['framework'],
      session_id: row.session_key.trim(),
      status: row.status,
      capabilities: mirror.config.capabilities,
      active_tasks: activeTasks,
      recent_success_rate: recentSuccessRate,
      score,
      reasons,
    })
  }

  candidates.sort((left, right) =>
    right.score - left.score
    || left.active_tasks - right.active_tasks
    || left.local_agent_id - right.local_agent_id,
  )
  return { selected: candidates[0] ?? null, candidates, rejected }
}
