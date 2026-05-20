import type Database from 'better-sqlite3'
import { getDatabase } from './db'

function dbOr(database?: Database.Database): Database.Database {
  return database ?? getDatabase()
}

export function getLicenseSetting(key: string, database?: Database.Database): string | null {
  const row = dbOr(database)
    .prepare(`SELECT value FROM settings WHERE key = ? LIMIT 1`)
    .get(key) as { value: string } | undefined
  return row?.value != null ? String(row.value) : null
}

export function setLicenseSetting(
  key: string,
  value: string,
  options: { category?: string; description?: string; updatedBy?: string | null } = {},
  database?: Database.Database,
): void {
  const db = dbOr(database)
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    `INSERT INTO settings (key, value, description, category, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       description = COALESCE(excluded.description, settings.description),
       category = COALESCE(excluded.category, settings.category),
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
  ).run(
    key,
    value,
    options.description ?? null,
    options.category ?? 'license',
    options.updatedBy ?? null,
    now,
  )
}

export const LICENSE_CENTER_URL_KEY = 'license.center_url'
export const OFFLINE_LICENSE_KEY_PREFIX = 'license.offline:'

export function offlineLicenseSettingKey(tenantId: number | string): string {
  return `${OFFLINE_LICENSE_KEY_PREFIX}${tenantId}`
}
