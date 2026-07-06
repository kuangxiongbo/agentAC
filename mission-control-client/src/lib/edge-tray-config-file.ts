import { homedir } from 'node:os'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export type EdgeTrayFileConfig = {
  center_url?: string
  enroll_token?: string
  gateway_token?: string
  device_id?: string
  client_name?: string
  port?: number
  enterprise_name?: string
  enterprise_slug?: string
  tenant_id?: string | number
}

export function edgeTrayConfigPath(): string {
  return path.join(homedir(), '.e-agent-edge', 'config.json')
}

export async function readEdgeTrayConfigFile(): Promise<EdgeTrayFileConfig | null> {
  try {
    const raw = await readFile(edgeTrayConfigPath(), 'utf8')
    const parsed = JSON.parse(raw) as EdgeTrayFileConfig
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** Map ~/.e-agent-edge/config.json → mission-control-client settings keys */
export function trayFileToSettings(tray: EdgeTrayFileConfig): Record<string, string> {
  const out: Record<string, string> = {}
  const centerUrl = String(tray.center_url || '').trim()
  const enrollToken = String(tray.enroll_token || '').trim()
  const gatewayToken = String(tray.gateway_token || '').trim()
  const deviceId = String(tray.device_id || '').trim()
  const clientName = String(tray.client_name || '').trim()
  const enterpriseName = String(tray.enterprise_name || '').trim()
  const enterpriseSlug = String(tray.enterprise_slug || '').trim()
  const tenantId = String(tray.tenant_id || '').trim()

  if (centerUrl) out['gateway.server_url'] = centerUrl
  if (enrollToken) out['edge.enroll_token'] = enrollToken
  if (gatewayToken) out['gateway.token'] = gatewayToken
  if (/^mc-edge-[a-z0-9-]+$/i.test(deviceId)) out['device.client_id'] = deviceId
  if (clientName) out['gateway.client_name'] = clientName
  if (enterpriseName) out['edge.enterprise_name'] = enterpriseName
  if (enterpriseSlug) out['edge.enterprise_slug'] = enterpriseSlug
  if (/^\d+$/.test(tenantId)) out['edge.tenant_id'] = tenantId
  return out
}
