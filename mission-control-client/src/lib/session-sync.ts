import { scanClaudeSessions } from './claude-sessions'
import { scanCodexSessions } from './codex-sessions'
import { scanHermesSessions } from './hermes-sessions'

export interface SyncableSessionRecord {
  session_id: string
  session_key?: string
  session_kind: 'claude-code' | 'codex-cli' | 'hermes'
  runtime_group: 'claude' | 'codex' | 'hermes'
  agent?: string
  model?: string
  tokens?: string
  age?: string
  active: boolean
  start_time?: number
  last_activity?: number
  working_dir?: string | null
  last_user_prompt?: string | null
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

function formatAgeFromMs(timestampMs: number): string {
  if (!timestampMs) return '-'
  const diff = Date.now() - timestampMs
  if (diff <= 0) return 'now'
  const mins = Math.floor(diff / 60000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d`
  if (hours > 0) return `${hours}h`
  return `${Math.max(0, mins)}m`
}

export async function getSyncableSessions(): Promise<SyncableSessionRecord[]> {
  const claudeSessions = await scanClaudeSessions().catch(() => [])
  const codexSessions = scanCodexSessions(100)
  const hermesSessions = scanHermesSessions(100)

  const claude = claudeSessions.map((session) => {
    const start = session.firstMessageAt ? new Date(session.firstMessageAt).getTime() : 0
    const last = session.lastMessageAt ? new Date(session.lastMessageAt).getTime() : 0
    return {
      session_id: session.sessionId,
      session_key: session.projectSlug || session.sessionId,
      session_kind: 'claude-code' as const,
      runtime_group: 'claude' as const,
      agent: session.projectSlug || 'claude',
      model: session.model || undefined,
      tokens: `${formatTokens(session.inputTokens || 0)}/${formatTokens(session.outputTokens || 0)}`,
      age: session.isActive ? 'now' : formatAgeFromMs(last),
      active: session.isActive,
      start_time: start || undefined,
      last_activity: last || undefined,
      working_dir: session.projectPath || null,
      last_user_prompt: session.lastUserPrompt || null,
    }
  })

  const codex = codexSessions.map((session) => {
    const start = session.firstMessageAt ? new Date(session.firstMessageAt).getTime() : 0
    const last = session.lastMessageAt ? new Date(session.lastMessageAt).getTime() : 0
    return {
      session_id: session.sessionId,
      session_key: session.projectSlug || session.sessionId,
      session_kind: 'codex-cli' as const,
      runtime_group: 'codex' as const,
      agent: session.projectSlug || 'codex',
      model: session.model || undefined,
      tokens: `${formatTokens(session.inputTokens || 0)}/${formatTokens(session.outputTokens || 0)}`,
      age: session.isActive ? 'now' : formatAgeFromMs(last),
      active: session.isActive,
      start_time: start || undefined,
      last_activity: last || undefined,
      working_dir: session.projectPath || null,
      last_user_prompt: null,
    }
  })

  const hermes = hermesSessions.map((session) => {
    const start = session.firstMessageAt ? new Date(session.firstMessageAt).getTime() : 0
    const last = session.lastMessageAt ? new Date(session.lastMessageAt).getTime() : 0
    return {
      session_id: session.sessionId,
      session_key: session.title || session.sessionId,
      session_kind: 'hermes' as const,
      runtime_group: 'hermes' as const,
      agent: 'hermes',
      model: session.model || undefined,
      tokens: `${formatTokens(session.inputTokens || 0)}/${formatTokens(session.outputTokens || 0)}`,
      age: session.isActive ? 'now' : formatAgeFromMs(last),
      active: session.isActive,
      start_time: start || undefined,
      last_activity: last || undefined,
      working_dir: null,
      last_user_prompt: session.title || null,
    }
  })

  return [...claude, ...codex, ...hermes]
    .sort((a, b) => (b.last_activity || 0) - (a.last_activity || 0))
    .slice(0, 100)
}
