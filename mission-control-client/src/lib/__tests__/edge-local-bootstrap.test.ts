import { beforeEach, describe, expect, it, vi } from 'vitest'

const { settings } = vi.hoisted(() => ({
  settings: new Map<string, string>(),
}))

vi.mock('@/lib/db', () => ({
  getDatabase: () => ({
    prepare: () => ({
      get: (key: string) => {
        const value = settings.get(key)
        return value == null ? undefined : { value }
      },
    }),
  }),
}))

import { buildLocalEdgeBootstrap } from '@/lib/edge-local-bootstrap'

describe('buildLocalEdgeBootstrap', () => {
  beforeEach(() => {
    settings.clear()
    settings.set('gateway.server_url', 'https://agent.example.test')
    settings.set('gateway.token', 'gateway-token')
    settings.set('edge.enroll_token', 'enroll-token')
    settings.set('gateway.client_name', 'edge-client')
    settings.set('edge.enterprise_name', 'Example')
    settings.set('edge.enterprise_slug', 'default')
  })

  it('preserves an existing mc-edge client id instead of re-hashing it', () => {
    const existingClientId = 'mc-edge-a8901a06c732'
    settings.set('device.client_id', existingClientId)

    const result = buildLocalEdgeBootstrap({ hostname: 'edge.local', deviceId: existingClientId })

    expect('payload' in result && result.payload.client.client_id).toBe(existingClientId)
    expect('payload' in result && result.payload.settings['device.client_id']).toBe(existingClientId)
  })

  it('derives a stable mc-edge id for raw device ids', () => {
    const result = buildLocalEdgeBootstrap({ hostname: 'edge.local', deviceId: 'raw-device' })

    expect('payload' in result && result.payload.client.client_id).toMatch(/^mc-edge-[a-f0-9]{12}$/)
  })
})
