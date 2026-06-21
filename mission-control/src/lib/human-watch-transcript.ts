import type { TranscriptMessage } from './session-transcript'
import type { HumanWatchTranscriptLine } from './human-watch-rules'

export function transcriptMessagesToHumanWatchLines(
  messages: TranscriptMessage[],
): HumanWatchTranscriptLine[] {
  return messages
    .map((message) => ({
      role: message.role,
      content: flattenTranscriptParts(message.parts),
      createdAt: message.timestamp
        ? Math.floor(new Date(message.timestamp).getTime() / 1000)
        : undefined,
    }))
    .filter((line) => !isPlatformControlLine(line.role, line.content))
}

function flattenTranscriptParts(parts: TranscriptMessage['parts']): string {
  const chunks: string[] = []
  for (const part of parts) {
    if (part.type === 'text' && part.text) chunks.push(part.text)
    else if (part.type === 'thinking' && part.thinking) chunks.push(part.thinking)
    else if (part.type === 'tool_use') chunks.push(`[tool_use ${part.name}]`)
    else if (part.type === 'tool_result') chunks.push(part.content)
  }
  return chunks.join('\n').trim()
}

function isPlatformControlLine(role: string, content: string): boolean {
  const normalizedRole = String(role || '').trim().toLowerCase()
  if (normalizedRole !== 'user') return false

  const normalized = String(content || '').trim().toLowerCase()
  if (!normalized) return false

  return (
    normalized.startsWith('<goal_context>') ||
    normalized.startsWith('<environment_context>') ||
    normalized.startsWith('<permissions instructions>') ||
    normalized.startsWith('<model_switch>') ||
    normalized.startsWith('<codex_internal_context') ||
    normalized == 'session continued, but no text response was returned.'
  )
}
