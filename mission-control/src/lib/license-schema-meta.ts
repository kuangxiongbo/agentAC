import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type LicenseEntitlementMeta = {
  key: string
  type: 'boolean' | 'number' | 'string'
  label: string
  description: string
  defaultValue: boolean | number | string
  enforcement: string
  enforcementPoint?: string
}

export type LicenseSchemaSettings = {
  appId: string
  displayName: string
  version: string
  requiresSubscription: boolean
  description: string
}

type RawSchema = {
  appId?: string
  displayName?: string
  version?: string
  requiresSubscription?: boolean
  description?: string
  entitlements?: Array<{
    key?: string
    type?: string
    label?: string
    description?: string
    default?: boolean | number | string
    enforcement?: string
    enforcementPoint?: string
  }>
}

let cachedRaw: RawSchema | null = null

function loadRawSchema(): RawSchema {
  if (cachedRaw) return cachedRaw
  const path = join(process.cwd(), 'license-schema.json')
  const raw = JSON.parse(readFileSync(path, 'utf8')) as RawSchema
  cachedRaw = raw
  return raw
}

export const LICENSE_SCHEMA_SETTINGS: LicenseSchemaSettings = (() => {
  const raw = loadRawSchema()
  return {
    appId: String(raw.appId || 'mission-control').trim(),
    displayName: String(raw.displayName || 'Agent 指挥仓').trim(),
    version: String(raw.version || '1.0.0').trim(),
    requiresSubscription: raw.requiresSubscription !== false,
    description: String(raw.description || '').trim(),
  }
})()

export const LICENSE_ENTITLEMENT_META_LIST: LicenseEntitlementMeta[] = (() => {
  const raw = loadRawSchema()
  const list = Array.isArray(raw.entitlements) ? raw.entitlements : []
  return list
    .filter((item) => typeof item.key === 'string' && item.key.trim())
    .map((item) => ({
      key: String(item.key).trim(),
      type: (item.type === 'number' || item.type === 'string' ? item.type : 'boolean') as LicenseEntitlementMeta['type'],
      label: String(item.label || item.key).trim(),
      description: String(item.description || '').trim(),
      defaultValue:
        item.default === undefined
          ? item.type === 'number'
            ? 0
            : item.type === 'string'
              ? ''
              : false
          : item.default,
      enforcement: String(item.enforcement || 'server').trim(),
      enforcementPoint: item.enforcementPoint ? String(item.enforcementPoint) : undefined,
    }))
})()

export function getLicenseSchemaTemplateJson(): string {
  return readFileSync(join(process.cwd(), 'license-schema.json'), 'utf8')
}
