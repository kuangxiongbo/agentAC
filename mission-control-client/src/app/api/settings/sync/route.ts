import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'

/**
 * POST /api/settings/sync
 * Receives global settings from another E-Agent-Client instance.
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const body = await request.json()
    const { settings } = body

    if (!Array.isArray(settings)) {
      return NextResponse.json({ error: 'Expected an array of settings' }, { status: 400 })
    }

    const db = getDatabase()
    const stmt = db.prepare(`
        INSERT INTO settings (key, value, category, updated_at, updated_by)
        VALUES (?, ?, ?, (unixepoch()), 'bridge-sync')
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at,
            updated_by = excluded.updated_by
        WHERE category = 'global' OR category = 'remote'
    `)

    let updatedCount = 0
    db.transaction(() => {
      for (const setting of settings) {
        // Only sync global or remote categories to avoid overwriting local identity/port/etc.
        if (setting.category === 'global' || setting.category === 'remote') {
          stmt.run(setting.key, setting.value, setting.category)
          updatedCount++
        }
      }
    })()

    return NextResponse.json({ ok: true, updated: updatedCount })
  } catch (err: any) {
    logger.error({ err }, 'Settings sync failed')
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
