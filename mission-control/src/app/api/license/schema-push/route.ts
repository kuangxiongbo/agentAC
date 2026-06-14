import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/auth'
import { getLicenseSchemaTemplateJson } from '@/lib/license-schema-meta'
import { getLicenseSetting, LICENSE_CENTER_URL_KEY } from '@/lib/license-settings-store'
import { LICENSE_APP_ID, APP_STAGE } from '@/lib/license-verifier'

function resolveUserCenterApiUrl(): string {
  const stored = getLicenseSetting(LICENSE_CENTER_URL_KEY)
  const fromDb = stored != null ? String(stored).trim() : ''
  const fromEnv = String(process.env.USER_CENTER_API_URL || process.env.USERCENTER_ORIGIN || '').trim()
  return (fromDb || fromEnv).replace(/\/$/, '')
}

export async function POST(request: Request) {
  const user = getUserFromRequest(request)
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  if (user.role !== 'admin') {
    return NextResponse.json({ error: 'Requires admin role' }, { status: 403 })
  }

  const baseUrl = resolveUserCenterApiUrl()
  if (!baseUrl) {
    return NextResponse.json({ error: '用户中心 API 地址未配置' }, { status: 400 })
  }

  let schemaJson: string
  try {
    schemaJson = getLicenseSchemaTemplateJson()
  } catch {
    return NextResponse.json({ error: '读取授权模板失败' }, { status: 500 })
  }

  const schema = JSON.parse(schemaJson) as Record<string, unknown>
  const secret = String(process.env.USER_CENTER_INTERNAL_SECRET || '').trim()

  try {
    const resp = await fetch(`${baseUrl}/api/internal/license-schema`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(secret ? { 'X-Internal-Secret': secret } : {}),
      },
      body: JSON.stringify({
        app_id: LICENSE_APP_ID,
        stage: APP_STAGE || null,
        schema,
      }),
      signal: AbortSignal.timeout(10_000),
    })

    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      return NextResponse.json(
        { error: `用户中心返回错误 ${resp.status}`, detail: body.slice(0, 400) },
        { status: 502 },
      )
    }

    const result = await resp.json().catch(() => ({}))
    return NextResponse.json({ ok: true, appId: LICENSE_APP_ID, result })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `推送失败: ${msg}` }, { status: 502 })
  }
}
