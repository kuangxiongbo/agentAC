import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'

describe('edge bootstrap tenant scoping', () => {
  let db: Database.Database
  const originalEnv = process.env

  beforeEach(() => {
    vi.resetModules()
    process.env = {
      ...originalEnv,
      API_KEY: 'test-api-key',
      AUTH_SECRET: 'test-auth-secret',
      MC_EDGE_ENROLL_TOKEN: '',
      MC_EDGE_ENROLL_TOKENS: '',
      MC_EDGE_ENROLL_ALLOW_API_KEY: '0',
      MC_EDGE_BRIDGE_TOKEN: 'bridge-token',
    }
    db = new Database(':memory:')
    runMigrations(db)
    db.prepare(`
      INSERT INTO tenants (slug, display_name, linux_user, plan_tier, status, openclaw_home, workspace_root, config, created_by)
      VALUES (?, ?, ?, 'standard', 'active', ?, ?, '{}', 'test')
    `).run('tenant-b', 'Tenant B', 'tenantb', '/tmp/tenant-b/openclaw', '/tmp/tenant-b/workspace')
    vi.doMock('@/lib/db', () => ({
      getDatabase: () => db,
    }))
  })

  afterEach(() => {
    db.close()
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  it('generates distinct session scoped enroll tokens per user tenant', async () => {
    const { resolveDistributionEnrollToken } = await import('@/lib/edge-bootstrap')

    const tenantOne = resolveDistributionEnrollToken({ id: 11, tenant_id: 1, workspace_id: 1 })
    const tenantTwo = resolveDistributionEnrollToken({ id: 22, tenant_id: 2, workspace_id: 2 })

    expect(tenantOne.source).toBe('session')
    expect(tenantTwo.source).toBe('session')
    expect(tenantOne.token).toMatch(/^mcet_/)
    expect(tenantTwo.token).toMatch(/^mcet_/)
    expect(tenantOne.token).not.toBe(tenantTwo.token)
  })

  it('binds bootstrap enterprise to the scoped token tenant', async () => {
    const { buildEdgeBootstrap, resolveDistributionEnrollToken } = await import('@/lib/edge-bootstrap')
    const token = resolveDistributionEnrollToken({ id: 22, tenant_id: 2, workspace_id: 2 }).token

    const result = buildEdgeBootstrap({
      centerUrl: 'https://center.example',
      enrollToken: token,
      hostname: 'mac001',
      deviceId: 'device-1',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.payload.enterprise).toMatchObject({
      name: 'Tenant B',
      slug: 'tenant-b',
      tenant_id: 2,
    })
    expect(result.payload.settings['edge.tenant_id']).toBe('2')
    expect(result.payload.settings['edge.enroll_token']).toBe(token)
    expect(result.payload.settings['gateway.token']).toBe('bridge-token')
    expect(result.payload.settings['gateway.token']).not.toBe(token)
  })
})
