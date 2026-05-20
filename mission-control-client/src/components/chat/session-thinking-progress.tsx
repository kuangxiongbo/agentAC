import type { SessionTranscriptMessage } from './session-message'

export type ThinkingProgressPhase = 'thinking' | 'tool' | 'responding'

export type ThinkingProgressState = {
  phase: ThinkingProgressPhase
  seconds: number
  toolName?: string
}

export function hasAssistantFinalText(message: SessionTranscriptMessage | undefined): boolean {
  if (!message || message.role !== 'assistant') return false
  return message.parts.some(
    (part) => part.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0,
  )
}

/** Any assistant text after the user send baseline (not only the last message). */
export function hasVisibleAssistantReplyAfterBaseline(
  messages: SessionTranscriptMessage[],
  baseline: number,
): boolean {
  const start = Math.max(0, baseline)
  for (let i = start; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role === 'assistant' && hasAssistantFinalText(msg)) {
      return true
    }
  }
  return false
}

export function findInFlightToolName(
  messages: SessionTranscriptMessage[],
  baseline: number,
): string | null {
  const completedToolIds = new Set<string>()
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === 'tool_result' && part.toolUseId) {
        completedToolIds.add(part.toolUseId)
      }
    }
  }

  const start = Math.max(0, baseline)
  for (let i = messages.length - 1; i >= start; i--) {
    const msg = messages[i]
    if (msg.role !== 'assistant') continue
    for (const part of msg.parts) {
      if (part.type === 'tool_use' && part.id && !completedToolIds.has(part.id)) {
        return part.name?.trim() || 'tool'
      }
    }
  }
  return null
}

export function deriveThinkingProgress(
  messages: SessionTranscriptMessage[],
  baseline: number,
  seconds: number,
): ThinkingProgressState {
  const toolName = findInFlightToolName(messages, baseline)
  if (toolName) {
    return { phase: 'tool', seconds, toolName }
  }

  const last = messages[messages.length - 1]
  if (messages.length > baseline && last?.role === 'assistant' && hasAssistantFinalText(last)) {
    return { phase: 'responding', seconds }
  }

  return { phase: 'thinking', seconds }
}

export type ReplyProgressUiMode = 'hidden' | 'waiting' | 'continuing'

export function deriveContinuingProgress(
  messages: SessionTranscriptMessage[],
  baseline: number,
  seconds: number,
): ThinkingProgressState {
  const toolName = findInFlightToolName(messages, baseline)
  if (toolName) {
    return { phase: 'tool', seconds, toolName }
  }
  return { phase: 'responding', seconds }
}

/** Split UI: wait for first visible reply vs. follow-up work after partial reply. */
export function resolveReplyProgressUi(
  awaitingReply: boolean,
  messages: SessionTranscriptMessage[],
  baseline: number,
  seconds: number,
): { mode: ReplyProgressUiMode; progress: ThinkingProgressState | null } {
  if (!awaitingReply) {
    return { mode: 'hidden', progress: null }
  }
  const hasVisible = hasVisibleAssistantReplyAfterBaseline(messages, baseline)
  if (!hasVisible) {
    return {
      mode: 'waiting',
      progress: deriveThinkingProgress(messages, baseline, seconds),
    }
  }
  // After the first visible assistant reply we cannot reliably detect multi-segment
  // completion on remote/bridge sessions — hide status and rely on transcript polling.
  return { mode: 'hidden', progress: null }
}

/** End the reply cycle when there is visible output and no in-flight tools in this turn. */
export function isReplyCycleComplete(
  messages: SessionTranscriptMessage[],
  baseline: number,
): boolean {
  if (!hasVisibleAssistantReplyAfterBaseline(messages, baseline)) {
    return false
  }
  return findInFlightToolName(messages, baseline) == null
}

export function thinkingProgressLabel(
  state: ThinkingProgressState,
  labels: {
    thinking: (seconds: number) => string
    tool: (tool: string, seconds: number) => string
    responding: (seconds: number) => string
  },
): string {
  if (state.phase === 'tool' && state.toolName) {
    return labels.tool(state.toolName, state.seconds)
  }
  if (state.phase === 'responding') {
    return labels.responding(state.seconds)
  }
  return labels.thinking(state.seconds)
}

export function continuingProgressLabel(
  state: ThinkingProgressState,
  labels: {
    continuing: (seconds: number) => string
    tool: (tool: string, seconds: number) => string
  },
): string {
  if (state.phase === 'tool' && state.toolName) {
    return labels.tool(state.toolName, state.seconds)
  }
  return labels.continuing(state.seconds)
}

export function transcriptSnapshot(messages: SessionTranscriptMessage[]): string {
  return JSON.stringify(
    messages.map((message) => ({
      role: message.role,
      timestamp: message.timestamp,
      parts: message.parts.map((part) => {
        switch (part.type) {
          case 'text':
            return { type: 'text', len: part.text.length, tail: part.text.slice(-48) }
          case 'thinking':
            return { type: 'thinking', len: part.thinking.length }
          case 'tool_use':
            return { type: 'tool_use', id: part.id, name: part.name }
          case 'tool_result':
            return { type: 'tool_result', id: part.toolUseId, len: part.content.length, err: part.isError }
          default:
            return { type: 'unknown' }
        }
      }),
    })),
  )
}

export function transcriptsEqual(
  a: SessionTranscriptMessage[],
  b: SessionTranscriptMessage[],
): boolean {
  if (a.length !== b.length) return false
  return transcriptSnapshot(a) === transcriptSnapshot(b)
}

interface ThinkingProgressBannerProps {
  label: string
  phase: ThinkingProgressPhase
}

export function ThinkingProgressBanner({ label, phase }: ThinkingProgressBannerProps) {
  return (
    <div
      className="mx-4 mb-2 flex items-center gap-2 rounded border border-primary/20 bg-primary/5 px-3 py-2"
      role="status"
      aria-live="polite"
    >
      <span className="inline-flex h-2 w-2 flex-shrink-0 animate-pulse rounded-full bg-primary/80" />
      <span className="font-mono-tight text-[11px] text-muted-foreground">{label}</span>
      {phase === 'tool' ? (
        <span className="font-mono-tight text-[10px] text-amber-400/80">{'\u2699'}</span>
      ) : null}
    </div>
  )
}

/** Shown after the first visible assistant reply while the run is still in progress. */
export function ContinuingProgressBanner({ label, phase }: ThinkingProgressBannerProps) {
  return (
    <div
      className="mx-4 mb-2 flex items-center gap-2 rounded border border-border/50 bg-muted/20 px-3 py-1.5"
      role="status"
      aria-live="polite"
    >
      <span className="inline-flex h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-void-cyan/80" />
      <span className="font-mono-tight text-[10px] text-muted-foreground">{label}</span>
      {phase === 'tool' ? (
        <span className="font-mono-tight text-[10px] text-amber-400/70">{'\u2699'}</span>
      ) : null}
    </div>
  )
}
