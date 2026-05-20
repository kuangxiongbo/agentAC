/**
 * Agent ↔ local CLI session binding rules (framework must match session kind).
 */

export type BindableSessionKind = 'claude-code' | 'codex-cli' | 'cursor' | 'opencode' | 'hermes'

export const BINDABLE_SESSION_KINDS = [
  'claude-code',
  'codex-cli',
  'cursor',
  'opencode',
  'hermes',
] as const

const RUNTIME_FRAMEWORKS: Array<{ kind: BindableSessionKind; frameworks: string[] }> = [
  { kind: 'claude-code', frameworks: ['claude', 'claude-code', 'claude-sdk'] },
  { kind: 'codex-cli', frameworks: ['codex', 'codex-cli', 'openai'] },
  { kind: 'cursor', frameworks: ['cursor'] },
  { kind: 'opencode', frameworks: ['opencode'] },
  { kind: 'hermes', frameworks: ['hermes'] },
]

const SESSION_KIND_LABELS: Record<BindableSessionKind, string> = {
  'claude-code': 'Claude',
  'codex-cli': 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  hermes: 'Hermes',
}

export function isBindableSessionKind(value: unknown): value is BindableSessionKind {
  return typeof value === 'string' && (BINDABLE_SESSION_KINDS as readonly string[]).includes(value)
}

export function getAgentLocalSessionKind(framework: string | null | undefined): BindableSessionKind | null {
  const normalized = String(framework || '').trim().toLowerCase()
  if (!normalized) return null

  for (const entry of RUNTIME_FRAMEWORKS) {
    if (entry.frameworks.includes(normalized)) return entry.kind
  }
  return null
}

export function getSessionKindDisplayName(kind: BindableSessionKind | string | null | undefined): string {
  if (isBindableSessionKind(kind)) return SESSION_KIND_LABELS[kind]
  return String(kind || 'unknown')
}

export function validateAgentSessionKindBinding(
  agentFramework: string | null | undefined,
  sessionKind: string | null | undefined,
): { ok: true } | { ok: false; message: string; agentKind: BindableSessionKind | null; sessionKind: BindableSessionKind | null } {
  const agentKind = getAgentLocalSessionKind(agentFramework)
  const normalizedSessionKind = isBindableSessionKind(sessionKind) ? sessionKind : null

  if (!normalizedSessionKind) {
    return {
      ok: false,
      message: 'Session type is not a bindable local runtime session',
      agentKind,
      sessionKind: null,
    }
  }

  if (!agentKind) {
    return {
      ok: false,
      message: 'Agent framework does not support binding to a local CLI session',
      agentKind: null,
      sessionKind: normalizedSessionKind,
    }
  }

  if (agentKind !== normalizedSessionKind) {
    return {
      ok: false,
      message: `Cannot bind a ${SESSION_KIND_LABELS[agentKind]} agent to a ${SESSION_KIND_LABELS[normalizedSessionKind]} session`,
      agentKind,
      sessionKind: normalizedSessionKind,
    }
  }

  return { ok: true }
}

export function assertAgentSessionKindBinding(
  agentFramework: string | null | undefined,
  sessionKind: string | null | undefined,
): void {
  const result = validateAgentSessionKindBinding(agentFramework, sessionKind)
  if (!result.ok) {
    throw new Error(result.message)
  }
}
