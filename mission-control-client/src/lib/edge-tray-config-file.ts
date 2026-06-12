import { homedir } from 'node:os'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export type EdgeTrayFileConfig = {
  center_url?: string
  enroll_token?: string
  client_name?: string
  port?: number
  enterprise_name?: string
  enterprise_slug?: string
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
  const token = String(tray.enroll_token || '').trim()
  const clientName = String(tray.client_name || '').trim()
  const enterpriseName = String(tray.enterprise_name || '').trim()
  const enterpriseSlug = String(tray.enterprise_slug || '').trim()

  if (centerUrl) out['gateway.server_url'] = centerUrl
  if (token) out['gateway.token'] = token
  if (clientName) out['gateway.client_name'] = clientName
  if (enterpriseName) out['edge.enterprise_name'] = enterpriseName
  if (enterpriseSlug) out['edge.enterprise_slug'] = enterpriseSlug
  return out
}
