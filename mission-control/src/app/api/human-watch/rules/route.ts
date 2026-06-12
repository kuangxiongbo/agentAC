import { NextRequest, NextResponse } from 'next/server'
import { getTenantIdFromRequest, requireRole } from '@/lib/auth'
import {
  getHumanWatchGlobalRules,
  normalizeGlobalRulesPatch,
  setHumanWatchGlobalRules,
} from '@/lib/human-watch-global-rules'
import { mutationLimiter } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

/**
 * GET /api/human-watch/rules — 租户全局值守判断规则（与设置页相同：admin）
 * PATCH — 更新全局规则（admin）
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const tenantId = auth.user.tenant_id ?? getTenantIdFromRequest(request)

  return NextResponse.json({
    tenant_id: tenantId,
    rules: getHumanWatchGlobalRules(tenantId),
  })
}

export async function PATCH(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  const tenantId = auth.user.tenant_id ?? getTenantIdFromRequest(request)

  let body: { rules?: Record<string, unknown> }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.rules || typeof body.rules !== 'object' || Array.isArray(body.rules)) {
    return NextResponse.json({ error: 'rules object is required' }, { status: 400 })
  }

  const rules = setHumanWatchGlobalRules(tenantId, normalizeGlobalRulesPatch(body.rules))

  return NextResponse.json({ tenant_id: tenantId, rules })
}
