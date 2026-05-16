import { NextRequest, NextResponse } from 'next/server'
import { createUsercenterTenant } from '@/lib/usercenter-tenant-gateway'
import { verifyZitadelOnboardingProof } from '@/lib/zitadel-onboarding-proof'

export const dynamic = 'force-dynamic'

function generateTenantSlug(tenantName: string): string {
  const fromName = tenantName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  const suffix = Date.now().toString(36).slice(-6)
  return (fromName && fromName.length >= 2 ? `${fromName}-${suffix}` : `org-${suffix}`).slice(0, 48)
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const proofRaw = typeof body?.proofToken === 'string' ? body.proofToken.trim() : ''
  const proof = proofRaw ? verifyZitadelOnboardingProof(proofRaw) : null
  if (!proof) {
    return NextResponse.json({ error: '认证凭证已失效，请重新登录后再试。' }, { status: 401 })
  }
  const tenantName = typeof body?.tenantName === 'string' ? body.tenantName.trim() : ''
  const tenantSlugInput = typeof body?.tenantSlug === 'string' ? body.tenantSlug.trim().toLowerCase() : ''
  if (!tenantName) {
    return NextResponse.json({ error: 'tenantName 为必填' }, { status: 400 })
  }
  const tenantSlug = tenantSlugInput || generateTenantSlug(tenantName)
  try {
    const created = await createUsercenterTenant({
      subject: proof.zitadelSub,
      email: proof.email,
      displayName:
        typeof body?.displayName === 'string' && body.displayName.trim() ? body.displayName.trim() : proof.displayName,
      name: tenantName,
      slug: tenantSlug,
    })
    return NextResponse.json({
      success: true,
      tenantId: String(created.tenantId),
      slug: created.slug,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const status = /slug_exists/i.test(msg) ? 409 : 500
    return NextResponse.json({ error: msg }, { status })
  }
}
