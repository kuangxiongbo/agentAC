import { describe, expect, it } from 'vitest'
import { shouldReconnectBridgeForSettingChange } from '@/lib/edge-bootstrap-settings'

describe('edge bootstrap bridge reconnect settings', () => {
  it('ignores volatile non-bridge settings', () => {
    expect(shouldReconnectBridgeForSettingChange('edge.enrolled_at', '100', '101')).toBe(false)
    expect(shouldReconnectBridgeForSettingChange('edge.hostname', 'old-host', 'new-host')).toBe(false)
    expect(shouldReconnectBridgeForSettingChange('gateway.client_name', 'old', 'new')).toBe(false)
  })

  it('reconnects when bridge connection settings change', () => {
    expect(shouldReconnectBridgeForSettingChange('gateway.server_url', 'https://a.example', 'https://b.example')).toBe(true)
    expect(shouldReconnectBridgeForSettingChange('gateway.token', 'old-token', 'new-token')).toBe(true)
    expect(shouldReconnectBridgeForSettingChange('device.client_id', 'edge-a', 'edge-b')).toBe(true)
  })

  it('does not reconnect for unchanged bridge settings', () => {
    expect(shouldReconnectBridgeForSettingChange('gateway.server_url', 'https://agent.example', 'https://agent.example')).toBe(false)
    expect(shouldReconnectBridgeForSettingChange('gateway.server_url', 'https://agent.example/', ' https://agent.example ')).toBe(false)
    expect(shouldReconnectBridgeForSettingChange('gateway.token', 'same-token', 'same-token')).toBe(false)
    expect(shouldReconnectBridgeForSettingChange('gateway.token', ' same-token ', 'same-token')).toBe(false)
    expect(shouldReconnectBridgeForSettingChange('device.client_id', 'edge-a', 'edge-a')).toBe(false)
  })
})
