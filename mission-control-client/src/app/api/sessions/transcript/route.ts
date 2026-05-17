import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import {
  readHermesTranscriptFromDbPath,
  readLocalSessionTranscriptPage,
  type LocalSessionTranscriptKind,
  type TranscriptMessage,
} from '@/lib/session-transcript'

const transcriptCache = new Map<string, { at: number; messages: TranscriptMessage[] }>()
const TRANSCRIPT_CACHE_MS = 4000

/**
 * GET /api/sessions/transcript
 * Query params:
 *   kind=claude-code|codex-cli|hermes
 *   id=<session-id>
 *   limit=40
 *   before=<cursor>  optional; load older chunk (msg:index or byte offset)
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const { searchParams } = new URL(request.url)
    const kind = searchParams.get('kind') || ''
    const sessionId = searchParams.get('id') || ''
    const limit = Math.min(parseInt(searchParams.get('limit') || '40', 10), 200)
    const before = searchParams.get('before') || undefined
    const nocache = searchParams.get('nocache') === '1'

    if (!sessionId || (kind !== 'claude-code' && kind !== 'codex-cli' && kind !== 'hermes')) {
      return NextResponse.json({ error: 'kind and id are required' }, { status: 400 })
    }

    const cacheKey = `${kind}:${sessionId}:${limit}:${before || 'latest'}`
    const cached = transcriptCache.get(cacheKey)
    const now = Date.now()
    if (!nocache && !before && cached && now - cached.at < TRANSCRIPT_CACHE_MS) {
      return NextResponse.json({ messages: cached.messages, cached: true })
    }

    const page = readLocalSessionTranscriptPage(kind as LocalSessionTranscriptKind, sessionId, { limit, before })
    if (!before) {
      transcriptCache.set(cacheKey, { at: now, messages: page.messages })
    }

    return NextResponse.json(page)
  } catch (error) {
    logger.error({ err: error }, 'GET /api/sessions/transcript error')
    return NextResponse.json({ error: 'Failed to fetch transcript' }, { status: 500 })
  }
}

export const dynamic = 'force-dynamic'
export const __testables = { readHermesTranscriptFromDbPath }
