import { existsSync } from 'node:fs'
import path from 'node:path'
import { config } from './config'
import type { LocalCliPermissionMode } from './local-cli-permission'

const MCP_SERVER_NAME = 'mission_control'

export interface CodexMcpInjectionOptions {
  managedByPlatform?: boolean
  agentId?: number | string | null
  agentName?: string | null
  workerSessionId?: string | null
  sessionKind?: string | null
  permissionMode?: LocalCliPermissionMode | null
}

function quoteTomlString(value: string): string {
  return JSON.stringify(value)
}

function quoteTomlInlineTable(value: Record<string, string>): string {
  return `{ ${Object.entries(value)
    .map(([key, val]) => `${key} = ${quoteTomlString(val)}`)
    .join(', ')} }`
}

function resolveMcpServerScript(): string {
  const candidates = [
    path.join(process.cwd(), 'scripts', 'mc-mcp-server.cjs'),
    path.join(process.cwd(), 'mission-control', 'scripts', 'mc-mcp-server.cjs'),
    path.join(config.homeDir, '.e-agent-center', 'mc-mcp-server.cjs'),
  ]
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0]
}

function resolveLocalMcUrl(): string {
  const explicit = (process.env.MC_MANAGED_MCP_URL || process.env.MC_URL || '').trim()
  if (explicit) return explicit.replace(/\/+$/, '')
  const port = (process.env.PORT || '3000').trim()
  return `http://127.0.0.1:${port}`
}

export function buildCodexMcpConfigArgs(options: CodexMcpInjectionOptions): string[] {
  if (!options.managedByPlatform) return []
  const scriptPath = resolveMcpServerScript()
  const env: Record<string, string> = {
    MC_URL: resolveLocalMcUrl(),
    MC_MANAGED_SESSION: '1',
    MC_MCP_ROLE: 'worker',
    MC_LOCAL_CLI_PERMISSION_MODE: options.permissionMode || 'standard',
  }
  if (options.agentId != null) env.MC_AGENT_ID = String(options.agentId)
  if (options.agentName) env.MC_AGENT_NAME = options.agentName
  if (options.workerSessionId) env.MC_WORKER_SESSION_ID = options.workerSessionId
  if (options.sessionKind) env.MC_SESSION_KIND = options.sessionKind

  return [
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.command=${quoteTomlString(process.execPath)}`,
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.args=${JSON.stringify([scriptPath])}`,
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.env=${quoteTomlInlineTable(env)}`,
  ]
}

export function withCodexMcpConfigArgs(
  args: string[],
  options: CodexMcpInjectionOptions,
): string[] {
  const configArgs = buildCodexMcpConfigArgs(options)
  return configArgs.length > 0 ? [...configArgs, ...args] : args
}
