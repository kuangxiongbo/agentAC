import raw from '../../license-schema.json'

export type ClientLicenseEntitlementMeta = {
  key: string
  label: string
  description: string
}

export const CLIENT_LICENSE_SCHEMA = {
  appId: String((raw as { appId?: string }).appId || 'mission-control'),
  displayName: String((raw as { displayName?: string }).displayName || 'Agent 指挥仓'),
  requiresSubscription: (raw as { requiresSubscription?: boolean }).requiresSubscription !== false,
}

export const CLIENT_LICENSE_ENTITLEMENT_META: ClientLicenseEntitlementMeta[] = (
  Array.isArray((raw as { entitlements?: unknown[] }).entitlements)
    ? (raw as { entitlements: Array<{ key?: string; label?: string; description?: string }> }).entitlements
    : []
)
  .filter((item) => typeof item.key === 'string' && item.key.trim())
  .map((item) => ({
    key: String(item.key).trim(),
    label: String(item.label || item.key).trim(),
    description: String(item.description || '').trim(),
  }))
