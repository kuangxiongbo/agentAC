import { NextRequest, NextResponse } from 'next/server'
import { applyUsercenterTenant, searchUsercenterTenant } from '@/lib/usercenter-tenant-gateway'
import { verifyZitadelOnboardingProof } from '@/lib/zitadel-onboarding-proof'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const proofRaw = typeof body?.proofToken === 'string' ? body.proofToken.trim() : ''
  const proof = proofRaw ? verifyZitadelOnboardingProof(proofRaw) : null
  if (!proof) {
    return NextResponse.json({ error: '认证凭证已失效，请重新登录后再试。' }, { status: 401 })
  }
  const tenantHint = typeof body?.tenantHint === 'string' ? body.tenantHint.trim() : ''
  if (!tenantHint) {
    return NextResponse.json({ error: 'tenantHint 必填' }, { status: 400 })
  }
  try {
    const searched = await searchUsercenterTenant({
      subject: proof.zitadelSub,
      email: proof.email,
      displayName: proof.displayName,
      q: tenantHint,
    })
    const tenantId =
      searched.exactMatch === true
        ? Number(searched.tenant.id)
        : searched.suggestion
          ? Number(searched.suggestion.id)
          : 0
    if (!tenantId) {
      return NextResponse.json({ error: '未找到匹配单位' }, { status: 404 })
    }
    await applyUsercenterTenant({
      subject: proof.zitadelSub,
      email: proof.email,
      displayName:
        typeof body?.displayName === 'string' && body.displayName.trim() ? body.displayName.trim() : proof.displayName,
      tenantId,
    })
    return NextResponse.json({
      success: true,
      tenantId: String(tenantId),
      tenantName:
        searched.exactMatch === true
          ? searched.tenant.name
          : searched.suggestion?.nameMasked || tenantHint,
      delivery: 'smtp' as const,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const status = /already_pending/i.test(msg) ? 409 : 500
    return NextResponse.json({ error: msg }, { status })
  }
}
