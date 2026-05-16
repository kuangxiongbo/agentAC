import { NextRequest, NextResponse } from 'next/server'
import { searchUsercenterTenant } from '@/lib/usercenter-tenant-gateway'
import { readOnboardingProofFromRequest } from '@/lib/zitadel-onboarding-proof'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const proof = readOnboardingProofFromRequest(request)
  if (!proof) {
    return NextResponse.json({ error: '认证凭证已失效，请重新登录后再试。' }, { status: 401 })
  }
  const q = String(request.nextUrl.searchParams.get('q') || '').trim()
  if (!q) {
    return NextResponse.json({ error: '请输入单位名称、slug 或租户 ID' }, { status: 400 })
  }
  try {
    const searched = await searchUsercenterTenant({
      subject: proof.zitadelSub,
      email: proof.email,
      displayName: proof.displayName,
      q,
    })
    if (searched.exactMatch === true) {
      return NextResponse.json({
        exactMatch: true,
        tenant: {
          tenantId: String(searched.tenant.id),
          tenantName: searched.tenant.name,
          slug: searched.tenant.slug,
        },
      })
    }
    return NextResponse.json({
      exactMatch: false,
      suggestion: searched.suggestion
        ? {
            tenantId: String(searched.suggestion.id),
            tenantName: searched.suggestion.nameMasked,
            slug: searched.suggestion.slug,
            loginRouteSegment: searched.suggestion.slug,
            score: 0.8,
          }
        : null,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
