import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const EDGE_CLIENT_ID_RE = /^mc-edge-[a-z0-9-]+$/i

function readTrayDeviceId(): string {
  try {
    const file = path.join(homedir(), '.e-agent-edge', 'config.json')
    if (!existsSync(file)) return ''
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { device_id?: unknown }
    const value = typeof parsed.device_id === 'string' ? parsed.device_id.trim() : ''
    return EDGE_CLIENT_ID_RE.test(value) ? value : ''
  } catch {
    return ''
  }
}

function getSetting(db: Database.Database, key: string): string {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value?: string } | undefined
  return typeof row?.value === 'string' ? row.value.trim() : ''
}

function upsertClientId(db: Database.Database, clientId: string, updatedBy: string): void {
  db.prepare(`
    INSERT INTO settings (key, value, category, updated_at, updated_by)
    VALUES ('device.client_id', ?, 'device', unixepoch(), ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = unixepoch(),
      updated_by = excluded.updated_by
  `).run(clientId, updatedBy)
}

export function resolveLocalClientId(
  db: Database.Database,
  fallback: string | (() => string) = 'mc-node-static',
): string {
  const trayClientId = readTrayDeviceId()
  if (trayClientId) {
    const current = getSetting(db, 'device.client_id')
    if (current !== trayClientId) {
      upsertClientId(db, trayClientId, 'edge-client-identity')
    }
    return trayClientId
  }

  const existing = getSetting(db, 'device.client_id')
  if (existing) return existing

  const created = typeof fallback === 'function' ? fallback() : fallback
  if (created) {
    upsertClientId(db, created, 'edge-client-identity')
    return created
  }
  return `mc-local-${randomUUID()}`
}
