import { getDatabase } from '@/lib/db'
import { edgeUpstreamFetch } from '@/lib/edge-upstream-fetch'
import { getRemoteUpstreamConfig } from '@/lib/remote-server-bridge'
import { resolveUserCenterSubscriptionsUrl } from '@/lib/local-cli-elevation-upstream'

export type LocalCliElevationEntitlement = {
  entitled: boolean
  subscriptionsUrl: string
}

export type LocalCliElevationGate =
  | { ok: true }
  | {
      ok: false
      status: number
      code: 'elevation_requires_subscription'
      error: string
      subscriptionsUrl: string
    }

function getGatewayToken(): string {
  try {
    const db = getDatabase()
    const row = db.prepare("SELECT value FROM settings WHERE key = 'gateway.token'").get() as { value?: string } | undefined
    return String(row?.value || '').trim()
  } catch {
    return ''
  }
}

function getEdgeEnrollToken(): string {
  try {
    const db = getDatabase()
    const row = db.prepare("SELECT value FROM settings WHERE key = 'edge.enroll_token'").get() as { value?: string } | undefined
    return String(row?.value || '').trim()
  } catch {
    return ''
  }
}

function getEdgeTenantId(): string {
  try {
    const db = getDatabase()
    const row = db.prepare("SELECT value FROM settings WHERE key = 'edge.tenant_id'").get() as { value?: string } | undefined
    return String(row?.value || '').trim()
  } catch {
    return ''
  }
}

export async function resolveLocalCliElevationEntitled(): Promise<LocalCliElevationEntitlement> {
  const upstream = getRemoteUpstreamConfig()
  const subscriptionsUrl = resolveUserCenterSubscriptionsUrl()
  const gatewayToken = getGatewayToken()
  const enrollToken = getEdgeEnrollToken()
  const token = gatewayToken || enrollToken
  const edgeTenantId = getEdgeTenantId()

  if (!upstream.baseUrl || !token) {
    return { entitled: false, subscriptionsUrl }
  }

  try {
    const base = upstream.baseUrl.replace(/\/+$/, '')
    const res = await edgeUpstreamFetch(`${base}/api/local-cli/elevation-entitled`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'x-api-key': token,
        ...(enrollToken ? { 'x-edge-enroll-token': enrollToken } : {}),
        ...(edgeTenantId ? { 'x-edge-tenant-id': edgeTenantId } : {}),
      },
      cache: 'no-store',
    })
    if (!res.ok) return { entitled: false, subscriptionsUrl }

    const body = await res.json().catch(() => null)
    if (!body || typeof body !== 'object') return { entitled: false, subscriptionsUrl }

    return {
      entitled: Boolean((body as { entitled?: boolean }).entitled),
      subscriptionsUrl: String((body as { subscriptionsUrl?: string }).subscriptionsUrl || subscriptionsUrl),
    }
  } catch {
    return { entitled: false, subscriptionsUrl }
  }
}

export async function assertLocalCliElevationAllowed(input: { elevated: boolean }): Promise<LocalCliElevationGate> {
  if (!input.elevated) return { ok: true }

  const entitlement = await resolveLocalCliElevationEntitled()
  if (entitlement.entitled) return { ok: true }

  return {
    ok: false,
    status: 403,
    code: 'elevation_requires_subscription',
    error: '本地 CLI 提权需要订阅 enableLocalCliElevation 权益，请先前往用户中心订阅。',
    subscriptionsUrl: entitlement.subscriptionsUrl,
  }
}
