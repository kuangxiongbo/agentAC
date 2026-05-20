import { NextRequest, NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/auth'
import type { LicFile } from '@/lib/effective-license'
import { saveOfflineLicense, verifyLicFile } from '@/lib/effective-license'
import { invalidateLicenseCache } from '@/lib/license-verifier'

export async function POST(request: NextRequest) {
  const user = getUserFromRequest(request)
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  if (user.role !== 'admin') {
    return NextResponse.json({ error: 'Requires admin role' }, { status: 403 })
  }

  const body = (await request.json().catch(() => ({}))) as { licContent?: unknown }
  let licFile: LicFile
  try {
    if (typeof body.licContent === 'string') {
      licFile = JSON.parse(body.licContent) as LicFile
    } else {
      licFile = body.licContent as LicFile
    }
  } catch {
    return NextResponse.json({ error: '无效的授权文件格式，请上传 JSON 格式的 .lic 文件' }, { status: 400 })
  }

  const check = verifyLicFile(licFile)
  if (!check.ok) {
    const msg =
      check.error === 'invalid_signature'
        ? '授权文件签名验证失败，文件可能已被篡改'
        : check.error === 'client_mismatch'
          ? '授权文件的目标应用与本系统不匹配'
          : check.error === 'expired'
            ? '授权文件已过期'
            : '文件解析失败'
    return NextResponse.json({ error: msg }, { status: 400 })
  }

  const tenantId = String(user.tenant_id || 1)
  saveOfflineLicense(tenantId, licFile)
  invalidateLicenseCache(tenantId)

  return NextResponse.json({
    ok: true,
    entitlements: licFile.payload.entitlements || {},
    expiresAt: licFile.payload.expiresAt !== 'never' ? licFile.payload.expiresAt : null,
  })
}
