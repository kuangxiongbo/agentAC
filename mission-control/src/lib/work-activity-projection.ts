import type Database from 'better-sqlite3'
import { getConnectedBridgeClients, requestBridgeClientActivitySnapshot } from './bridge-server'
import { listWorkProjectionSnapshots, saveWorkProjectionSnapshot } from './work-projection-snapshots'

export interface ProjectedWorkActivity extends Record<string, unknown> {
  id: number
  type: string
  entity_type: string
  entity_id: number
  actor: string
  description: string
  created_at: number
  source: 'local_runtime' | 'local_snapshot'
  authority: 'local_runtime' | 'local_snapshot'
  stale: boolean
  snapshot_at?: number
  local_activity_id: string
  bridge_client_id: string
  client_id: string
  client_label: string
  data: Record<string, unknown> | null
}

export interface WorkActivityProjection {
  activities: ProjectedWorkActivity[]
  clients: Array<{
    client_id: string
    client_label: string
    total: number
    truncated: boolean
    live: boolean
    stale: boolean
    snapshot_at?: number
  }>
  errors: Array<{ client_id: string; error: string }>
}

const CACHE_TTL_MS = 1500
const projectionCache: Map<number, { expiresAt: number; promise: Promise<WorkActivityProjection> }> =
  (globalThis as any).__workActivityProjectionCache || new Map()
;(globalThis as any).__workActivityProjectionCache = projectionCache

function parseObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
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

export function projectedWorkActivityId(clientId: string, localActivityId: string): number {
  const key = `${clientId}:${localActivityId}`
  const high = hash32(key, 0x811c9dc5) & 0x1fffff
  const low = hash32(key, 0x9e3779b9)
  return -(high * 0x100000000 + low || 1)
}

function mapActivity(
  clientId: string,
  clientLabel: string,
  activity: Record<string, unknown>,
  snapshotAt?: number,
): ProjectedWorkActivity | null {
  const localActivityId = String(activity.id ?? '').trim()
  const createdAt = Number(activity.created_at)
  if (!localActivityId || !Number.isFinite(createdAt) || createdAt <= 0) return null
  const data = parseObject(activity.data)
  return {
    ...activity,
    id: projectedWorkActivityId(clientId, localActivityId),
    type: typeof activity.type === 'string' ? activity.type : 'activity',
    entity_type: typeof activity.entity_type === 'string' ? activity.entity_type : 'activity',
    entity_id: Number.isFinite(Number(activity.entity_id)) ? Number(activity.entity_id) : 0,
    actor: typeof activity.actor === 'string' && activity.actor.trim() ? activity.actor : clientLabel,
    description: typeof activity.description === 'string' ? activity.description : '',
    created_at: Math.floor(createdAt),
    source: snapshotAt ? 'local_snapshot' : 'local_runtime',
    authority: snapshotAt ? 'local_snapshot' : 'local_runtime',
    stale: Boolean(snapshotAt),
    ...(snapshotAt ? { snapshot_at: snapshotAt } : {}),
    local_activity_id: localActivityId,
    bridge_client_id: clientId,
    client_id: clientId,
    client_label: clientLabel,
    data: data ? { ...data, local_activity_id: localActivityId, bridge_client_id: clientId, ...(snapshotAt ? { snapshot_at: snapshotAt, stale: true } : {}) } : {
      local_activity_id: localActivityId,
      bridge_client_id: clientId,
      ...(snapshotAt ? { snapshot_at: snapshotAt, stale: true } : {}),
    },
  }
}

async function loadProjection(db: Database.Database, workspaceId: number): Promise<WorkActivityProjection> {
  const allowed = new Set(
    (db.prepare('SELECT client_id FROM sync_clients WHERE workspace_id = ?').all(workspaceId) as Array<{ client_id: string }>)
      .map((row) => row.client_id),
  )
  const connected = getConnectedBridgeClients('activity_snapshot').filter((client) => allowed.has(client.clientId))
  const settled = await Promise.allSettled(connected.map(async (client) => ({
    client,
    snapshot: await requestBridgeClientActivitySnapshot({ clientId: client.clientId, limit: 1000, timeoutMs: 5000 }),
  })))
  const activities: ProjectedWorkActivity[] = []
  const clients: WorkActivityProjection['clients'] = []
  const errors: WorkActivityProjection['errors'] = []
  const liveClientIds = new Set<string>()
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
    liveClientIds.add(client.clientId)
    try {
      saveWorkProjectionSnapshot(db, {
        workspaceId,
        clientId: client.clientId,
        clientLabel: client.clientLabel,
        kind: 'activities',
        payload: snapshot as unknown as Record<string, unknown>,
      })
    } catch (error) {
      errors.push({ client_id: client.clientId, error: `Snapshot persistence failed: ${error instanceof Error ? error.message : String(error)}` })
    }
    for (const activity of snapshot.activities) {
      const mapped = mapActivity(client.clientId, client.clientLabel, activity)
      if (mapped) activities.push(mapped)
    }
    clients.push({
      client_id: client.clientId,
      client_label: client.clientLabel,
      total: snapshot.total,
      truncated: snapshot.truncated,
      live: true,
      stale: false,
    })
  })
  const stored = listWorkProjectionSnapshots<{
    activities?: Array<Record<string, unknown>>
    total?: number
    truncated?: boolean
  }>(db, workspaceId, 'activities', liveClientIds)
    .filter((snapshot) => allowed.has(snapshot.clientId))
  for (const snapshot of stored) {
    for (const activity of Array.isArray(snapshot.payload.activities) ? snapshot.payload.activities : []) {
      const mapped = mapActivity(snapshot.clientId, snapshot.clientLabel, activity, snapshot.capturedAt)
      if (mapped) activities.push(mapped)
    }
    clients.push({
      client_id: snapshot.clientId,
      client_label: snapshot.clientLabel,
      total: Number(snapshot.payload.total || 0),
      truncated: snapshot.payload.truncated === true,
      live: false,
      stale: true,
      snapshot_at: snapshot.capturedAt,
    })
  }
  activities.sort((left, right) => right.created_at - left.created_at || left.id - right.id)
  return { activities, clients, errors }
}

export function getLiveWorkActivityProjection(
  db: Database.Database,
  workspaceId: number,
  options: { fresh?: boolean } = {},
): Promise<WorkActivityProjection> {
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

export function clearWorkActivityProjectionCache() {
  projectionCache.clear()
}
