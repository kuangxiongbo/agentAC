import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import {
  isLocalSessionKind,
  enqueueLocalSessionPrompt,
  type LocalSessionKind,
} from '@/lib/local-session-executor'
import { elevatedFlagToPermissionMode, isLocalCliElevatedFlag } from '@/lib/parse-local-cli-elevated'
import { assertLocalCliElevationAllowed } from '@/lib/local-cli-elevation-auth'
import { createLocalCliElevationGrant, logLocalCliElevationDenied } from '@/lib/local-cli-elevation-audit'
import { mutationLimiter } from '@/lib/rate-limit'
/**
 * POST /api/sessions/continue
 * Body: { kind: 'claude-code'|'codex-cli'|'cursor'|'opencode'|'hermes', id: string, prompt: string }
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  let kind: LocalSessionKind | undefined
  try {
    const body = await request.json().catch(() => ({}))
    kind = body?.kind as LocalSessionKind
    const sessionId = typeof body?.id === 'string' ? body.id.trim() : ''
    const prompt = typeof body?.prompt === 'string' ? body.prompt : ''
    const workingDir = typeof body?.working_dir === 'string' ? body.working_dir.trim() : ''
    const workerLocalAgentId = Number(body?._worker_local_agent_id)
    const workerSessionId = typeof body?._worker_session_id === 'string'
      ? body._worker_session_id.trim()
      : ''
    const managedByPlatform = body?._managed_by_platform === true
      && Boolean(request.headers.get('x-api-key'))
      && Number.isInteger(workerLocalAgentId)
      && workerLocalAgentId > 0
      && workerSessionId === sessionId
    const localCliElevated = isLocalCliElevatedFlag(body?.local_cli_elevated)
    const elevationGate = await assertLocalCliElevationAllowed({ elevated: localCliElevated })
    if (!elevationGate.ok) {
      logLocalCliElevationDenied({
        targetType: 'session_continue',
        targetId: sessionId,
        sessionKind: kind,
        sessionId,
        source: 'edge_sessions_continue_api',
        reason: elevationGate.code,
      })
      return NextResponse.json(
        {
          error: elevationGate.error,
          code: elevationGate.code,
          subscriptionsUrl: elevationGate.subscriptionsUrl,
        },
        { status: elevationGate.status }
      )
    }
    const permissionMode = elevatedFlagToPermissionMode(localCliElevated)
    if (localCliElevated) {
      createLocalCliElevationGrant({
        targetType: 'session_continue',
        targetId: sessionId,
        sessionKind: kind,
        sessionId,
        source: 'edge_sessions_continue_api',
      })
    }

    if (!isLocalSessionKind(kind)) {
      return NextResponse.json({ error: 'Invalid kind' }, { status: 400 })
    }
    enqueueLocalSessionPrompt(kind, sessionId, prompt, {
      workingDirectory: workingDir || null,
      permissionMode,
      managedByPlatform,
      agent: managedByPlatform ? { id: workerLocalAgentId } : null,
      workerSessionId: managedByPlatform ? workerSessionId : null,
      sessionKind: managedByPlatform ? kind : null,
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
