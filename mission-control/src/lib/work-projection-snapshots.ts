import type Database from 'better-sqlite3'

export type WorkProjectionSnapshotKind = 'tasks' | 'activities'

export interface StoredWorkProjectionSnapshot<T extends Record<string, unknown>> {
  workspaceId: number
  clientId: string
  clientLabel: string
  kind: WorkProjectionSnapshotKind
  payload: T
  capturedAt: number
}

const MAX_SNAPSHOT_AGE_SECONDS = 7 * 24 * 60 * 60
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024

export function saveWorkProjectionSnapshot<T extends Record<string, unknown>>(
  db: Database.Database,
  input: Omit<StoredWorkProjectionSnapshot<T>, 'capturedAt'> & { capturedAt?: number },
): void {
  const payloadJson = JSON.stringify(input.payload)
  if (Buffer.byteLength(payloadJson, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new Error(`Work ${input.kind} snapshot exceeds ${MAX_PAYLOAD_BYTES} bytes`)
  }
  const capturedAt = input.capturedAt ?? Math.floor(Date.now() / 1000)
  db.prepare(`
    INSERT INTO work_projection_snapshots (
      workspace_id, client_id, client_label, kind, payload_json, captured_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(workspace_id, client_id, kind) DO UPDATE SET
      client_label = excluded.client_label,
      payload_json = excluded.payload_json,
      captured_at = excluded.captured_at,
      updated_at = unixepoch()
  `).run(input.workspaceId, input.clientId, input.clientLabel, input.kind, payloadJson, capturedAt)
  db.prepare(`DELETE FROM work_projection_snapshots WHERE captured_at < ?`)
    .run(capturedAt - MAX_SNAPSHOT_AGE_SECONDS)
}

export function listWorkProjectionSnapshots<T extends Record<string, unknown>>(
  db: Database.Database,
  workspaceId: number,
  kind: WorkProjectionSnapshotKind,
  excludeClientIds: Iterable<string> = [],
  now = Math.floor(Date.now() / 1000),
): Array<StoredWorkProjectionSnapshot<T>> {
  const excluded = new Set(excludeClientIds)
  const rows = db.prepare(`
    SELECT workspace_id, client_id, client_label, kind, payload_json, captured_at
    FROM work_projection_snapshots
    WHERE workspace_id = ? AND kind = ? AND captured_at >= ?
    ORDER BY captured_at DESC, client_id ASC
  `).all(workspaceId, kind, now - MAX_SNAPSHOT_AGE_SECONDS) as Array<{
    workspace_id: number
    client_id: string
    client_label: string
    kind: WorkProjectionSnapshotKind
    payload_json: string
    captured_at: number
  }>
  return rows.flatMap((row) => {
    if (excluded.has(row.client_id)) return []
    try {
      const payload = JSON.parse(row.payload_json)
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
      return [{
        workspaceId: row.workspace_id,
        clientId: row.client_id,
        clientLabel: row.client_label,
        kind: row.kind,
        payload: payload as T,
        capturedAt: row.captured_at,
      }]
    } catch {
      return []
    }
  })
}

export const WORK_PROJECTION_SNAPSHOT_MAX_AGE_SECONDS = MAX_SNAPSHOT_AGE_SECONDS
