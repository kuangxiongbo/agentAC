import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, db_helpers } from '@/lib/db'
import { eventBus } from '@/lib/event-bus'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'

/**
 * POST /api/chat/sync
 * Receives chat messages from another E-Agent-Client instance (bridge).
 */
export async function POST(request: NextRequest) {
  // Allow bridge sync - ideally with an API key
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const body = await request.json()
    const { message } = body
    if (!message || !message.content || !message.conversation_id) {
      return NextResponse.json({ error: 'Invalid message payload' }, { status: 400 })
    }

    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1

    // Check if message already exists to avoid duplicates
    const existing = db.prepare('SELECT id FROM messages WHERE conversation_id = ? AND content = ? AND created_at = ? AND workspace_id = ?')
      .get(message.conversation_id, message.content, message.created_at, workspaceId)

    if (existing) {
      return NextResponse.json({ ok: true, message: 'Message already synced', duplicate: true })
    }

    // Insert the synced message
    const stmt = db.prepare(`
      INSERT INTO messages (conversation_id, from_agent, to_agent, content, message_type, metadata, workspace_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const result = stmt.run(
      message.conversation_id,
      message.from_agent,
      message.to_agent || null,
      message.content,
      message.message_type || 'text',
      message.metadata ? (typeof message.metadata === 'string' ? message.metadata : JSON.stringify(message.metadata)) : null,
      workspaceId,
      message.created_at || Math.floor(Date.now() / 1000)
    )

    const syncedMessage = {
      ...message,
      id: result.lastInsertRowid,
      workspace_id: workspaceId
    }

    // Broadcast to local clients so the UI updates in real-time
    eventBus.broadcast('chat.message', syncedMessage)

    return NextResponse.json({ ok: true, id: result.lastInsertRowid })
  } catch (err: any) {
    logger.error({ err }, 'Chat sync failed')
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
