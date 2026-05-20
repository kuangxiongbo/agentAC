import type { BindableSessionKind } from './agent-session-binding'
import { getAgentLocalSessionKind, isBindableSessionKind } from './agent-session-binding'

export const HUMAN_WATCH_AGENT_KIND = 'human_watch'
export const HUMAN_WATCH_AGENT_ROLE = 'human-watch'

export function parseAgentConfigRecord(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }
  return typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function isHumanWatchAgent(input: {
  role?: string | null
  config?: unknown
} | null | undefined): boolean {
  if (!input) return false
  if (String(input.role || '').trim() === HUMAN_WATCH_AGENT_ROLE) return true
  const config = parseAgentConfigRecord(input.config)
  return String(config.agent_kind || '').trim() === HUMAN_WATCH_AGENT_KIND
}

export function normalizeHumanWatchFramework(
  framework: string | null | undefined,
): BindableSessionKind | null {
  const normalized = String(framework || '').trim().toLowerCase()
  if (isBindableSessionKind(normalized)) return normalized
  return getAgentLocalSessionKind(framework)
}
