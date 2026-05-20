export type SessionRealtimeSource =
  | 'claude'
  | 'codex'
  | 'hermes'
  | 'gateway'
  | 'cursor'
  | 'opencode'
  | 'synced'
export type SessionRealtimeKind =
  | 'claude-code'
  | 'codex-cli'
  | 'hermes'
  | 'gateway'
  | 'cursor'
  | 'opencode'

export interface SessionRealtimePayload {
  source: SessionRealtimeSource
  sessionKind?: SessionRealtimeKind
  sessionId?: string
  sessionKey?: string
  reason?: string
  /** Optimistic user line while CLI is still running (prompt_queued). */
  pendingPrompt?: string
  /** Match open chat when session id is not known yet (first message / provisioning). */
  agentId?: number
  workspace_id?: number
}

/** Client-only: show pending user message in open chat before JSONL updates. */
export function dispatchSessionTranscriptUpdated(detail: SessionRealtimePayload) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<SessionRealtimePayload>(SESSION_TRANSCRIPT_UPDATED_EVENT, { detail }))
}

export function dispatchSessionPendingPrompt(
  sessionKind: SessionRealtimeKind,
  sessionId: string,
  pendingPrompt: string,
  reason = 'prompt_queued',
  agentId?: number,
) {
  const source = sessionSourceFromKind(sessionKind)
  if (!source || !pendingPrompt.trim()) return
  if (!sessionId.trim() && agentId == null) return
  dispatchSessionTranscriptUpdated({
    source,
    sessionKind,
    ...(sessionId.trim() ? { sessionId, sessionKey: sessionId } : {}),
    ...(agentId != null ? { agentId } : {}),
    reason,
    pendingPrompt: pendingPrompt.trim(),
  })
}

export const SESSION_LIST_UPDATED_EVENT = 'mc:session-list-updated'
export const SESSION_TRANSCRIPT_UPDATED_EVENT = 'mc:session-transcript-updated'

export function sessionKindFromSource(source: SessionRealtimeSource): SessionRealtimeKind | undefined {
  switch (source) {
    case 'claude':
      return 'claude-code'
    case 'codex':
      return 'codex-cli'
    case 'hermes':
      return 'hermes'
    case 'gateway':
      return 'gateway'
    case 'cursor':
      return 'cursor'
    case 'opencode':
      return 'opencode'
    default:
      return undefined
  }
}

export function sessionSourceFromKind(kind: string): SessionRealtimeSource | undefined {
  switch (kind) {
    case 'claude-code':
      return 'claude'
    case 'codex-cli':
      return 'codex'
    case 'hermes':
      return 'hermes'
    case 'gateway':
      return 'gateway'
    case 'cursor':
      return 'cursor'
    case 'opencode':
      return 'opencode'
    default:
      return undefined
  }
}
