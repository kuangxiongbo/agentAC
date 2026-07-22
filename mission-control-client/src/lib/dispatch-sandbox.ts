import { realpathSync, statSync } from 'node:fs'
import path from 'node:path'

export const CLAUDE_CLI_ALLOWED_TOOL_NAMES = [
  'Task', 'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'MultiEdit', 'Write',
  'NotebookEdit', 'WebFetch', 'WebSearch', 'TodoWrite',
] as const

export const CLI_MAX_BUDGET_USD_CEILING = 100

export interface DispatchSandboxInput {
  dispatchAllowedTools?: unknown
  dispatch_allowed_tools?: unknown
  dispatchMaxBudgetUsd?: unknown
  dispatch_max_budget_usd?: unknown
  dispatchCwd?: unknown
  dispatch_cwd?: unknown
}

export interface CliDispatchSandboxOptions {
  allowedTools: string[] | null
  maxBudgetUsd: number | null
  cwd: string | null
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { return record(JSON.parse(value)) } catch { return {} }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function filterCliAllowedTools(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null
  const valid = input.filter((entry): entry is string =>
    typeof entry === 'string'
    && (CLAUDE_CLI_ALLOWED_TOOL_NAMES as readonly string[]).includes(entry),
  )
  return [...new Set(valid)].length > 0 ? [...new Set(valid)] : null
}

export function clampCliMaxBudgetUsd(input: unknown): number | null {
  if (typeof input !== 'number' || !Number.isFinite(input) || input <= 0) return null
  return Math.min(input, CLI_MAX_BUDGET_USD_CEILING)
}

export function resolveCliDispatchCwd(input: unknown, workspaceRoot: string | null | undefined): string | null {
  if (typeof input !== 'string' || !input.trim() || !workspaceRoot) return null
  try {
    const realRoot = realpathSync(path.resolve(workspaceRoot))
    const realCwd = realpathSync(path.resolve(realRoot, input.trim()))
    if (realCwd !== realRoot && !realCwd.startsWith(realRoot + path.sep)) return null
    return statSync(realCwd).isDirectory() ? realCwd : null
  } catch {
    return null
  }
}

function pick(source: Record<string, unknown>, camel: string, snake: string): unknown {
  return source[camel] !== undefined ? source[camel] : source[snake]
}

export function resolveCliDispatchSandboxOptions(
  agentConfig: unknown,
  overrides: DispatchSandboxInput = {},
  workspaceRoot?: string | null,
): CliDispatchSandboxOptions {
  const base = record(agentConfig)
  const override = record(overrides)
  const rawOverrideTools = pick(override, 'dispatchAllowedTools', 'dispatch_allowed_tools')
  const baseTools = filterCliAllowedTools(pick(base, 'dispatchAllowedTools', 'dispatch_allowed_tools'))
  const overrideTools = filterCliAllowedTools(rawOverrideTools)
  if (rawOverrideTools !== undefined && !overrideTools) {
    throw new Error('Dispatch task tool policy does not contain any supported tools')
  }
  if (baseTools && overrideTools && !baseTools.some((tool) => overrideTools.includes(tool))) {
    throw new Error('Dispatch tool policy has no tools allowed by both agent and task')
  }
  const allowedTools = baseTools && overrideTools
    ? baseTools.filter((tool) => overrideTools.includes(tool))
    : overrideTools || baseTools

  const rawOverrideBudget = pick(override, 'dispatchMaxBudgetUsd', 'dispatch_max_budget_usd')
  const baseBudget = clampCliMaxBudgetUsd(pick(base, 'dispatchMaxBudgetUsd', 'dispatch_max_budget_usd'))
  const overrideBudget = clampCliMaxBudgetUsd(rawOverrideBudget)
  if (rawOverrideBudget !== undefined && overrideBudget === null) {
    throw new Error('Dispatch task budget must be a positive finite number')
  }
  const maxBudgetUsd = baseBudget !== null && overrideBudget !== null
    ? Math.min(baseBudget, overrideBudget)
    : overrideBudget ?? baseBudget

  const rawOverrideCwd = pick(override, 'dispatchCwd', 'dispatch_cwd')
  const baseCwd = resolveCliDispatchCwd(pick(base, 'dispatchCwd', 'dispatch_cwd'), workspaceRoot)
  const overrideCwd = resolveCliDispatchCwd(rawOverrideCwd, workspaceRoot)
  if (rawOverrideCwd !== undefined && !overrideCwd) {
    throw new Error('Dispatch task working directory is outside the agent workspace')
  }

  return {
    allowedTools: allowedTools && allowedTools.length > 0 ? allowedTools : null,
    maxBudgetUsd,
    cwd: overrideCwd || baseCwd,
  }
}
