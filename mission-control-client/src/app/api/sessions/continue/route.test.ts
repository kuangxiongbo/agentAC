import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const enqueueLocalSessionPrompt = vi.fn()

vi.mock('@/lib/auth', () => ({
  requireRole: () => ({ user: { id: 1, role: 'operator', workspace_id: 1 } }),
}))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: () => null }))
vi.mock('@/lib/workspace-isolation', () => ({ denyResourceOutsideWorkspace: () => null }))
vi.mock('@/lib/local-session-executor', () => ({
  enqueueLocalSessionPrompt,
  isLocalSessionKind: (kind: string) => kind === 'codex-cli',
}))
vi.mock('@/lib/local-cli-elevation-auth', () => ({
  assertLocalCliElevationAllowed: async () => ({ ok: true }),
}))
vi.mock('@/lib/local-cli-elevation-audit', () => ({
  createLocalCliElevationGrant: vi.fn(),
  logLocalCliElevationDenied: vi.fn(),
}))

describe('POST /api/sessions/continue managed context', () => {
  beforeEach(() => enqueueLocalSessionPrompt.mockReset())

  it('preserves platform-managed Worker identity from an authenticated MCP proxy call', async () => {
    const { POST } = await import('./route')
    const request = new NextRequest('http://localhost/api/sessions/continue', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'test-key' },
      body: JSON.stringify({
        kind: 'codex-cli',
        id: 'session-1',
        prompt: 'continue',
        _managed_by_platform: true,
        _worker_local_agent_id: 6,
        _worker_session_id: 'session-1',
      }),
    })

    expect((await POST(request)).status).toBe(200)
    expect(enqueueLocalSessionPrompt).toHaveBeenCalledWith(
      'codex-cli',
      'session-1',
      'continue',
      expect.objectContaining({
        managedByPlatform: true,
        agent: { id: 6 },
        workerSessionId: 'session-1',
        sessionKind: 'codex-cli',
      }),
    )
  })

  it('does not trust managed identity fields from a browser cookie request', async () => {
    const { POST } = await import('./route')
    const request = new NextRequest('http://localhost/api/sessions/continue', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: '__Host-mc-session=test' },
      body: JSON.stringify({
        kind: 'codex-cli',
        id: 'session-1',
        prompt: 'continue',
        _managed_by_platform: true,
        _worker_local_agent_id: 6,
        _worker_session_id: 'session-1',
      }),
    })

    expect((await POST(request)).status).toBe(200)
    expect(enqueueLocalSessionPrompt).toHaveBeenCalledWith(
      'codex-cli',
      'session-1',
      'continue',
      expect.objectContaining({
        managedByPlatform: false,
        agent: null,
        workerSessionId: null,
      }),
    )
  })
})
