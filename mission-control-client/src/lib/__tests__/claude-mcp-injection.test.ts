import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildClaudeMcpConfigArgs,
  withClaudeMcpConfigArgs,
} from '@/lib/claude-mcp-injection'

describe('claude-mcp-injection', () => {
  it('does not inject MCP config for unmanaged Claude invocations', () => {
    expect(buildClaudeMcpConfigArgs({ managedByPlatform: false })).toEqual([])
    expect(withClaudeMcpConfigArgs(['--print', 'hello'], { managedByPlatform: false }))
      .toEqual(['--print', 'hello'])
  })

  it('injects a temporary MCP server for platform-managed Claude sessions', () => {
    const args = buildClaudeMcpConfigArgs({
      managedByPlatform: true,
      agentId: 42,
      agentName: 'worker',
      workerSessionId: 'session-123',
      sessionKind: 'claude-code',
      permissionMode: 'full',
    })

    expect(args[0]).toBe('--mcp-config')
    const config = JSON.parse(args[1]!)
    const server = config.mcpServers.mission_control
    expect(server.type).toBe('stdio')
    expect(server.command).toBe(process.execPath)
    expect(server.args[0]).toMatch(/mc-mcp-server\.cjs$/)
    expect(server.env).toMatchObject({
      MC_MANAGED_SESSION: '1',
      MC_MCP_ROLE: 'worker',
      MC_AGENT_ID: '42',
      MC_AGENT_NAME: 'worker',
      MC_WORKER_SESSION_ID: 'session-123',
      MC_SESSION_KIND: 'claude-code',
      MC_LOCAL_CLI_PERMISSION_MODE: 'full',
    })

    const finalArgs = withClaudeMcpConfigArgs(['--print', 'hello'], {
      managedByPlatform: true,
      permissionMode: 'standard',
    })
    expect(finalArgs.slice(-2)).toEqual(['--print', 'hello'])
  })

  it('lets the injected MCP process inherit the Runtime API key', () => {
    const script = readFileSync(path.join(process.cwd(), 'scripts/mc-mcp-server.cjs'), 'utf8')
    expect(script).toContain('process.env.MC_API_KEY || process.env.API_KEY')
  })
})
