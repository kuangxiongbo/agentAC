export const BRIDGE_RECONNECT_SETTING_KEYS = new Set([
  'device.client_id',
  'gateway.server_url',
  'gateway.token',
])

export function normalizeSettingValue(value: unknown): string {
  return String(value ?? '').trim()
}

export function normalizeBridgeSettingValue(key: string, value: unknown): string {
  const normalized = normalizeSettingValue(value)
  if (key === 'gateway.server_url') {
    return normalized.replace(/\/+$/, '')
  }
  return normalized
}

export function shouldReconnectBridgeForSettingChange(
  key: string,
  previousValue: unknown,
  nextValue: unknown,
): boolean {
  if (!BRIDGE_RECONNECT_SETTING_KEYS.has(key)) return false
  return normalizeBridgeSettingValue(key, previousValue) !== normalizeBridgeSettingValue(key, nextValue)
}
