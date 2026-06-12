export type LocalCliPermissionMode = 'standard' | 'full'

export const LOCAL_CLI_PERMISSION_MODES: LocalCliPermissionMode[] = ['standard', 'full']

export function parseLocalCliPermissionMode(value: unknown): LocalCliPermissionMode | null {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (!normalized) return null
  if (normalized === 'full' || normalized === 'elevated' || normalized === 'unrestricted') {
    return 'full'
  }
  if (normalized === 'standard' || normalized === 'default' || normalized === 'restricted') {
    return 'standard'
  }
  return null
}

/** Per-request explicit mode only; optional dev env fallback. */
export function resolveLocalCliPermissionMode(
  _agent?: { config?: unknown } | null,
  explicit?: LocalCliPermissionMode | null,
): LocalCliPermissionMode {
  if (explicit) return explicit
  const fromEnv = parseLocalCliPermissionMode(process.env.MC_LOCAL_CLI_PERMISSION_MODE)
  if (fromEnv) return fromEnv
  return 'standard'
}

export function withLocalCliPermissionArgs(
  program: 'claude' | 'codex',
  args: string[],
  mode: LocalCliPermissionMode,
): string[] {
  if (mode !== 'full') return args

  if (program === 'codex') {
    if (args.includes('--dangerously-bypass-approvals-and-sandbox')) return args
    return [...args, '--dangerously-bypass-approvals-and-sandbox']
  }

  if (program === 'claude') {
    if (args.includes('--dangerously-skip-permissions')) return args
    return [...args, '--dangerously-skip-permissions']
  }

  return args
}

export function buildLocalCliOperatingRules(mode: LocalCliPermissionMode): string[] {
  if (mode === 'full') {
    return [
      'Operating rules:',
      '1. You have full local CLI permissions for this session (shell commands, network access, and paths outside the workspace when required).',
      '2. Prefer staying aligned with the role definition, but do not refuse tasks solely because they exceed a sandbox boundary.',
      '3. If a request conflicts with the role, explain the conflict briefly and proceed when the user intent is clear.',
    ]
  }

  return [
    'Operating rules:',
    '1. Stay within this role and its scope.',
    '2. Keep responses aligned with the role definition unless a higher-priority system instruction overrides it.',
    '3. If a request conflicts with the role, explain the conflict instead of silently changing identity.',
  ]
}
