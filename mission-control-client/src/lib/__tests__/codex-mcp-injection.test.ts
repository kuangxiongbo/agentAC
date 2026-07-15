import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { buildCodexMcpConfigArgs, withCodexMcpConfigArgs } from '@/lib/codex-mcp-injection'

describe('codex-mcp-injection', () => {
  it('does not inject MCP config for unmanaged Codex invocations', () => {
    expect(buildCodexMcpConfigArgs({ managedByPlatform: false })).toEqual([])
    expect(withCodexMcpConfigArgs(['exec', 'hello'], { managedByPlatform: false })).toEqual(['exec', 'hello'])
  })

  it('injects temporary mcp_servers config for platform-managed Codex sessions', () => {
    const args = buildCodexMcpConfigArgs({
      managedByPlatform: true,
      agentId: 42,
      agentName: 'worker',
      workerSessionId: 'session-123',
      sessionKind: 'codex-cli',
      permissionMode: 'full',
    })

    expect(args).toContain('-c')
    expect(args.some((arg) => arg.startsWith('mcp_servers.mission_control.command='))).toBe(true)
    expect(args.some((arg) => arg.startsWith('mcp_servers.mission_control.args='))).toBe(true)
    expect(args.some((arg) => arg.includes('MC_MANAGED_SESSION = "1"'))).toBe(true)
    expect(args.some((arg) => arg.includes('MC_AGENT_ID = "42"'))).toBe(true)
    expect(args.some((arg) => arg.includes('MC_WORKER_SESSION_ID = "session-123"'))).toBe(true)
    expect(args.some((arg) => arg.includes('MC_SESSION_KIND = "codex-cli"'))).toBe(true)
    expect(args.some((arg) => arg.includes('MC_LOCAL_CLI_PERMISSION_MODE = "full"'))).toBe(true)

    const finalArgs = withCodexMcpConfigArgs(['exec', 'hello'], {
      managedByPlatform: true,
      permissionMode: 'standard',
    })
    expect(finalArgs.slice(-2)).toEqual(['exec', 'hello'])
  })

  it('binds supervised completion identity to the managed process environment', () => {
    const script = readFileSync(path.join(process.cwd(), 'scripts/mc-mcp-server.cjs'), 'utf8')
    const completion = script.slice(
      script.indexOf("name: 'mc_complete_supervision_task'"),
      script.indexOf("name: 'mc_create_task'"),
    )
    expect(completion).toContain('managedWorkerCompletionContext(args)')
    expect(completion).toContain('destructiveHint: false')
    expect(completion).toContain('idempotentHint: true')
    expect(completion).not.toContain('worker_local_agent_id: {')
    expect(completion).not.toContain('worker_session_id: {')

    const goalRead = script.slice(
      script.indexOf("name: 'mc_get_supervision_goal'"),
      script.indexOf("name: 'mc_complete_supervision_task'"),
    )
    expect(goalRead).toContain('readOnlyHint: true')
    expect(script).toContain('...(t.annotations ? { annotations: t.annotations } : {})')
  })
})
