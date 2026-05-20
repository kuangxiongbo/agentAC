import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/auth'
import { getLicenseSchemaTemplateJson } from '@/lib/license-schema-meta'
import { LICENSE_APP_ID } from '@/lib/license-verifier'

export async function GET(request: Request) {
  const user = getUserFromRequest(request)
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  if (user.role !== 'admin') {
    return NextResponse.json({ error: 'Requires admin role' }, { status: 403 })
  }

  try {
    const raw = getLicenseSchemaTemplateJson()
    return new NextResponse(raw, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${LICENSE_APP_ID}.license-schema.json"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch {
    return NextResponse.json({ error: '读取授权配置模板失败' }, { status: 500 })
  }
}
