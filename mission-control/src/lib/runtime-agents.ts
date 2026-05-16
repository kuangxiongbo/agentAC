export type MainAgentRuntimeId =
  | 'openclaw'
  | 'hermes'
  | 'claude'
  | 'codex'
  | 'cursor'
  | 'opencode'

export interface MainAgentRuntimeMeta {
  id: MainAgentRuntimeId
  label: string
  mainAgentName: string
  description: string
  shortLabel: string
  installSupported: boolean
}

const MAIN_AGENT_RUNTIME_META: Record<MainAgentRuntimeId, MainAgentRuntimeMeta> = {
  openclaw: {
    id: 'openclaw',
    label: 'OpenClaw',
    mainAgentName: 'OpenClaw (Main)',
    description: 'Native orchestration with gateway sessions and workspace isolation.',
    shortLabel: 'OC',
    installSupported: true,
  },
  hermes: {
    id: 'hermes',
    label: 'Hermes',
    mainAgentName: 'Hermes (Main)',
    description: 'Hermes Agent runtime with local state, sessions, and hooks.',
    shortLabel: 'HM',
    installSupported: true,
  },
  claude: {
    id: 'claude',
    label: 'Claude Code',
    mainAgentName: 'Claude Code (Main)',
    description: 'Anthropic CLI agent with local coding sessions.',
    shortLabel: 'CC',
    installSupported: true,
  },
  codex: {
    id: 'codex',
    label: 'Codex CLI',
    mainAgentName: 'Codex CLI (Main)',
    description: 'OpenAI Codex CLI with local coding sessions.',
    shortLabel: 'CX',
    installSupported: true,
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    mainAgentName: 'Cursor (Main)',
    description: 'Cursor IDE runtime detection and parent agent anchor.',
    shortLabel: 'CR',
    installSupported: false,
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    mainAgentName: 'OpenCode (Main)',
    description: 'OpenCode runtime detection and parent agent anchor.',
    shortLabel: 'OP',
    installSupported: false,
  },
}

export const MAIN_AGENT_RUNTIME_ORDER: MainAgentRuntimeId[] = [
  'openclaw',
  'claude',
  'codex',
  'cursor',
  'opencode',
  'hermes',
]

export function getMainAgentRuntimeMeta(id: MainAgentRuntimeId | string): MainAgentRuntimeMeta | undefined {
  return MAIN_AGENT_RUNTIME_META[id as MainAgentRuntimeId]
}

export function getMainAgentRuntimeFromSessionKind(kind: string): MainAgentRuntimeId | 'other' {
  switch (kind) {
    case 'gateway':
      return 'openclaw'
    case 'claude-code':
      return 'claude'
    case 'codex-cli':
      return 'codex'
    case 'hermes':
      return 'hermes'
    case 'cursor':
      return 'cursor'
    case 'opencode':
      return 'opencode'
    default:
      return 'other'
  }
}
