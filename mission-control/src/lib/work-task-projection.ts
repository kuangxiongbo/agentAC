import type Database from 'better-sqlite3'
import { getConnectedBridgeClients, requestBridgeClientTaskSnapshot } from './bridge-server'

export interface ProjectedWorkTask extends Record<string, unknown> {
  id: number
  status: string
  source: 'local_runtime'
  authority: 'local_runtime'
  local_task_id: number
  bridge_client_id: string
  client_id: string
  client_label: string
  metadata: Record<string, unknown>
  tags: unknown[]
}

export interface WorkTaskProjection {
  tasks: ProjectedWorkTask[]
  clients: Array<{
    client_id: string
    client_label: string
    total: number
    by_status: Record<string, number>
    truncated: boolean
  }>
  errors: Array<{ client_id: string; error: string }>
}

const CACHE_TTL_MS = 1500
const projectionCache: Map<number, { expiresAt: number; promise: Promise<WorkTaskProjection> }> =
  (globalThis as any).__workTaskProjectionCache || new Map()
;(globalThis as any).__workTaskProjectionCache = projectionCache

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function parseArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function hash32(value: string, seed: number): number {
  let hash = seed >>> 0
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

export function projectedWorkTaskId(clientId: string, localTaskId: number): number {
  const key = `${clientId}:${localTaskId}`
  const high = hash32(key, 0x811c9dc5) & 0x1fffff
  const low = hash32(key, 0x9e3779b9)
  const value = high * 0x100000000 + low
  return -(value || 1)
}

function mapTask(clientId: string, clientLabel: string, task: Record<string, unknown>): ProjectedWorkTask | null {
  const localTaskId = Number(task.id)
  if (!Number.isInteger(localTaskId) || localTaskId <= 0) return null
  const projectPrefix = typeof task.project_prefix === 'string' ? task.project_prefix.trim() : ''
  const ticketNo = Number(task.project_ticket_no)
  return {
    ...task,
    id: projectedWorkTaskId(clientId, localTaskId),
    local_task_id: localTaskId,
    bridge_client_id: clientId,
    client_id: clientId,
    client_label: clientLabel,
    source: 'local_runtime',
    authority: 'local_runtime',
    status: typeof task.status === 'string' ? task.status : 'inbox',
    tags: parseArray(task.tags),
    metadata: {
      ...parseObject(task.metadata),
      local_task_id: localTaskId,
      bridge_client_id: clientId,
    },
    ...(projectPrefix && Number.isFinite(ticketNo) && ticketNo > 0
      ? { ticket_ref: `${projectPrefix}-${String(ticketNo).padStart(3, '0')}` }
      : {}),
  }
}

async function loadProjection(db: Database.Database, workspaceId: number): Promise<WorkTaskProjection> {
  const allowed = new Set(
    (db.prepare('SELECT client_id FROM sync_clients WHERE workspace_id = ?').all(workspaceId) as Array<{ client_id: string }>)
      .map((row) => row.client_id),
  )
  const connected = getConnectedBridgeClients('task_snapshot').filter((client) => allowed.has(client.clientId))
  const settled = await Promise.allSettled(connected.map(async (client) => ({
    client,
    snapshot: await requestBridgeClientTaskSnapshot({ clientId: client.clientId, limit: 1000, timeoutMs: 5000 }),
  })))
  const tasks: ProjectedWorkTask[] = []
  const clients: WorkTaskProjection['clients'] = []
  const errors: WorkTaskProjection['errors'] = []
  settled.forEach((result, index) => {
    const client = connected[index]
    if (result.status === 'rejected') {
      errors.push({
        client_id: client.clientId,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      })
      return
    }
    const { snapshot } = result.value
    for (const task of snapshot.tasks) {
      const mapped = mapTask(client.clientId, client.clientLabel, task)
      if (mapped) tasks.push(mapped)
    }
    clients.push({
      client_id: client.clientId,
      client_label: client.clientLabel,
      total: snapshot.total,
      by_status: snapshot.byStatus,
      truncated: snapshot.truncated,
    })
  })
  return { tasks, clients, errors }
}

export function getLiveWorkTaskProjection(
  db: Database.Database,
  workspaceId: number,
  options: { fresh?: boolean } = {},
): Promise<WorkTaskProjection> {
  const now = Date.now()
  const cached = projectionCache.get(workspaceId)
  if (!options.fresh && cached && cached.expiresAt > now) return cached.promise
  const promise = loadProjection(db, workspaceId).catch((error) => {
    projectionCache.delete(workspaceId)
    throw error
  })
  projectionCache.set(workspaceId, { expiresAt: now + CACHE_TTL_MS, promise })
  return promise
}

export function mergeCloudAndProjectedTasks(
  cloudTasks: Array<Record<string, unknown>>,
  localTasks: ProjectedWorkTask[],
): Array<Record<string, unknown>> {
  const cloudById = new Map(cloudTasks.map((task) => [String(task.id), task]))
  const replacedCloudIds = new Set<string>()
  const mergedLocal = localTasks.map((local) => {
    const localMetadata = parseObject(local.metadata)
    const remoteTaskId = localMetadata.remote_task_id
    const cloud = remoteTaskId == null ? undefined : cloudById.get(String(remoteTaskId))
    if (!cloud) return local
    replacedCloudIds.add(String(cloud.id))
    return {
      ...cloud,
      ...local,
      project_id: local.project_id ?? cloud.project_id,
      project_name: local.project_name ?? cloud.project_name,
      project_prefix: local.project_prefix ?? cloud.project_prefix,
      project_ticket_no: local.project_ticket_no ?? cloud.project_ticket_no,
      ticket_ref: local.ticket_ref ?? cloud.ticket_ref,
      metadata: {
        ...parseObject(cloud.metadata),
        ...localMetadata,
        cloud_task_id: cloud.id,
      },
    }
  })
  const cloudOnly = cloudTasks
    .filter((task) => !replacedCloudIds.has(String(task.id)))
    .map((task) => ({ ...task, source: 'cloud_control', authority: 'cloud' }))
  const combined: Array<Record<string, unknown>> = [...mergedLocal, ...cloudOnly]
  return combined.sort((left, right) => {
    const updated = Number(right.updated_at || 0) - Number(left.updated_at || 0)
    return updated || Number(right.created_at || 0) - Number(left.created_at || 0)
  })
}

export function countTasksByStatus(tasks: Array<Record<string, unknown>>) {
  const byStatus: Record<string, number> = {}
  for (const task of tasks) {
    const status = typeof task.status === 'string' ? task.status : 'inbox'
    byStatus[status] = (byStatus[status] || 0) + 1
  }
  return { total: tasks.length, byStatus }
}

export function clearWorkTaskProjectionCache() {
  projectionCache.clear()
}
