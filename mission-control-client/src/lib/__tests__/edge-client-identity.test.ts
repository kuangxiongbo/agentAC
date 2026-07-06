import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runMigrations } from '@/lib/migrations'
import { resolveLocalClientId } from '@/lib/edge-client-identity'

describe('resolveLocalClientId', () => {
  let db: Database.Database
  let home: string

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
    home = mkdtempSync(path.join(tmpdir(), 'edge-client-identity-'))
    vi.stubEnv('HOME', home)
  })

  afterEach(() => {
    db.close()
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  it('prefers the tray mc-edge device id and repairs stale DB settings', () => {
    const edgeHome = path.join(home, '.e-agent-edge')
    mkdirSync(edgeHome, { recursive: true })
    writeFileSync(path.join(edgeHome, 'config.json'), JSON.stringify({ device_id: 'mc-edge-a8901a06c732' }))
    db.prepare(`INSERT OR REPLACE INTO settings (key, value, category) VALUES ('device.client_id', 'mc-edge-74d743833aab', 'device')`).run()

    expect(resolveLocalClientId(db, 'fallback')).toBe('mc-edge-a8901a06c732')
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'device.client_id'`).get() as { value: string }
    expect(row.value).toBe('mc-edge-a8901a06c732')
  })
})
