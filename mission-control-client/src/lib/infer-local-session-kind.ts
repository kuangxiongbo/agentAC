import { findClaudeSessionFilePath } from './claude-sessions'
import { scanCodexSessions } from './codex-sessions'
import type { BindableSessionKind } from './agent-session-binding'
import { isBindableSessionKind } from './agent-session-binding'

/** Resolve local session kind from on-disk session stores (server-side only). */
export function inferLocalSessionKindFromSessionId(sessionId: string): BindableSessionKind | null {
  const normalized = String(sessionId || '').trim()
  if (!normalized) return null

  if (findClaudeSessionFilePath(normalized)) return 'claude-code'

  const codexHit = scanCodexSessions(500).find((row) => row.sessionId === normalized)
  if (codexHit) return 'codex-cli'

  return null
}

export function resolveSessionKindForBinding(
  sessionId: string,
  explicitKind: unknown,
): BindableSessionKind | null {
  if (isBindableSessionKind(explicitKind)) return explicitKind
  return inferLocalSessionKindFromSessionId(sessionId)
}
