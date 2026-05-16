export type SessionRealtimeSource = 'claude' | 'codex' | 'hermes' | 'gateway' | 'synced'
export type SessionRealtimeKind = 'claude-code' | 'codex-cli' | 'hermes' | 'gateway'

export interface SessionRealtimePayload {
  source: SessionRealtimeSource
  sessionKind?: SessionRealtimeKind
  sessionId?: string
  sessionKey?: string
  reason?: string
  workspace_id?: number
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
    default:
      return undefined
  }
}
