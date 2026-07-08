export const BRIDGE_RECONNECT_SETTING_KEYS = new Set([
  'device.client_id',
  'gateway.server_url',
  'gateway.token',
])

export function normalizeSettingValue(value: unknown): string {
  return String(value ?? '')
}

export function shouldReconnectBridgeForSettingChange(
  key: string,
  previousValue: unknown,
  nextValue: unknown,
): boolean {
  if (!BRIDGE_RECONNECT_SETTING_KEYS.has(key)) return false
  return normalizeSettingValue(previousValue) !== normalizeSettingValue(nextValue)
}

