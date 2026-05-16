import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { requestBridgeClientSessionTranscript } from '@/lib/bridge-server'
import { logger } from '@/lib/logger'
import {
  readHermesTranscriptFromDbPath,
  readLocalSessionTranscript,
  type LocalSessionTranscriptKind,
} from '@/lib/session-transcript'

/**
 * GET /api/sessions/transcript
 * Query params:
 *   kind=claude-code|codex-cli|hermes
 *   id=<session-id>
 *   client_id=<remote-client-id> (optional, fetch from connected edge node)
 *   limit=40
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const { searchParams } = new URL(request.url)
    const kind = searchParams.get('kind') || ''
    const sessionId = searchParams.get('id') || ''
    const clientId = searchParams.get('client_id') || ''
    const limit = Math.min(parseInt(searchParams.get('limit') || '40', 10), 200)

    if (!sessionId || (kind !== 'claude-code' && kind !== 'codex-cli' && kind !== 'hermes')) {
      return NextResponse.json({ error: 'kind and id are required' }, { status: 400 })
    }

    if (clientId) {
      try {
        const remote = await requestBridgeClientSessionTranscript({
          clientId,
          kind: kind as LocalSessionTranscriptKind,
          sessionId,
          limit,
        })
        return NextResponse.json({ messages: remote.messages, source: remote.source, client_id: clientId, remote: true })
      } catch (bridgeErr) {
        const msg = bridgeErr instanceof Error ? bridgeErr.message : String(bridgeErr)
        if (/not connected|socket unavailable|timed out/i.test(msg)) {
          return NextResponse.json({
            error:
              '边缘客户端未通过 Bridge 连接，无法读取本机会话记录。请在本机保持代理客户端运行，并确保其已连上中心服务端的 Bridge WebSocket。',
            code: 'bridge_offline',
            client_id: clientId,
          }, { status: 503 })
        }
        throw bridgeErr
      }
    }

    const messages = readLocalSessionTranscript(kind as LocalSessionTranscriptKind, sessionId, limit)

    return NextResponse.json({ messages })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/sessions/transcript error')
    return NextResponse.json({ error: 'Failed to fetch transcript' }, { status: 500 })
  }
}

export const dynamic = 'force-dynamic'
export const __testables = { readHermesTranscriptFromDbPath }
