import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import {
  isLocalSessionKind,
  enqueueLocalSessionPrompt,
  type LocalSessionKind,
} from '@/lib/local-session-executor'
/**
 * POST /api/sessions/continue
 * Body: { kind: 'claude-code'|'codex-cli'|'cursor'|'opencode'|'hermes', id: string, prompt: string }
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  let kind: LocalSessionKind | undefined
  try {
    const body = await request.json().catch(() => ({}))
    kind = body?.kind as LocalSessionKind
    const sessionId = typeof body?.id === 'string' ? body.id.trim() : ''
    const prompt = typeof body?.prompt === 'string' ? body.prompt : ''
    const workingDir = typeof body?.working_dir === 'string' ? body.working_dir.trim() : ''

    if (!isLocalSessionKind(kind)) {
      return NextResponse.json({ error: 'Invalid kind' }, { status: 400 })
    }
    enqueueLocalSessionPrompt(kind, sessionId, prompt, {
      workingDirectory: workingDir || null,
    })

    return NextResponse.json({ ok: true, accepted: true, sessionId })
  } catch (error: any) {
    logger.error({ err: error }, 'POST /api/sessions/continue error')
    const message = error?.message || 'Failed to continue session'
    const isMissingBin = error?.code === 'ENOENT' || String(message).includes('ENOENT')
    const status = isMissingBin ? 503 : 500
    const hint = isMissingBin && kind === 'codex-cli'
      ? '未找到 codex 命令。请在本机安装 Codex CLI，或在 mission-control-client/.env.local 设置 MC_CODEX_BIN=/opt/homebrew/bin/codex'
      : isMissingBin
        ? '未找到本地 CLI。请在 Mac 上使用 http://127.0.0.1:5001 继续本地会话，勿在生产站点发送。'
        : message
    return NextResponse.json({ error: hint }, { status })
  }
}

export const dynamic = 'force-dynamic'
