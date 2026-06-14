import { describe, expect, it } from 'vitest'
import { trayFileToSettings } from '@/lib/edge-tray-config-file'

describe('trayFileToSettings', () => {
  it('keeps enroll token separate from bridge gateway token', () => {
    const settings = trayFileToSettings({
      center_url: 'https://agent.example',
      enroll_token: 'mcet_user_scoped_token',
      client_name: 'edge-mac',
      enterprise_name: 'Tenant A',
      enterprise_slug: 'tenant-a',
      tenant_id: 12,
    })

    expect(settings['gateway.server_url']).toBe('https://agent.example')
    expect(settings['edge.enroll_token']).toBe('mcet_user_scoped_token')
    expect(settings['gateway.token']).toBeUndefined()
    expect(settings['gateway.client_name']).toBe('edge-mac')
    expect(settings['edge.enterprise_name']).toBe('Tenant A')
    expect(settings['edge.enterprise_slug']).toBe('tenant-a')
    expect(settings['edge.tenant_id']).toBe('12')
  })

  it('imports explicit gateway token only when present', () => {
    const settings = trayFileToSettings({
      enroll_token: 'mcet_user_scoped_token',
      gateway_token: 'bridge-token',
    })

    expect(settings['edge.enroll_token']).toBe('mcet_user_scoped_token')
    expect(settings['gateway.token']).toBe('bridge-token')
  })
})
