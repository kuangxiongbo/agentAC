import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { createSession, createUser, updateUser } from '@/lib/auth'
import { getDatabase, logAuditEvent } from '@/lib/db'
import { getMcSessionCookieName, getMcSessionCookieOptions, isRequestSecure } from '@/lib/session-cookie'
import { oidcFlowLimiter } from '@/lib/rate-limit'
import {
  exchangeCodeForTokens,
  fetchOidcUserInfo,
  oidcIsConfigured,
  verifyIdToken,
} from '@/lib/oidc-zitadel'
import { verifyOidcFlowCookie } from '@/lib/oidc-flow-cookie'
import {
  buildUserCenterOnboardingRedirectUrl,
  isUsercenterApiConfigured,
  resolveUserCenterPortalBase,
  resolveUsercenterOnboardingMode,
} from '@/lib/usercenter-tenant-gateway'
import {
  provisionLocalUserFromUsercenterTenant,
  deriveZitadelLocalUsername,
  syncExistingUserWithUsercenterPortal,
  ensureOrganizationBindingForUser,
  type UsercenterPortalTenant,
} from '@/lib/usercenter-provision-local'
import {
  createUsercenterTenant,
  fetchUsercenterTenantContextIfConfigured,
} from '@/lib/usercenter-tenant-gateway'
import { resolveAutoOrganizationName, slugFromOrganizationName } from '@/lib/tenant-auth-scope'
import { resolveRequestOrigin } from '@/lib/request-origin'
import {
  MC_PENDING_ONBOARDING_COOKIE,
  signZitadelOnboardingProof,
} from '@/lib/zitadel-onboarding-proof'

export const dynamic = 'force-dynamic'

const OIDC_FLOW_COOKIE = 'mc_oidc_flow'
const OIDC_ID_TOKEN_COOKIE = 'mc_oidc_id_token'

function redirectToLogin(request: NextRequest, params?: Record<string, string>) {
  const url = new URL('/login', resolveRequestOrigin(request))
  for (const [k, v] of Object.entries(params || {})) {
    if (v) url.searchParams.set(k, v)
  }
  const res = NextResponse.redirect(url.toString(), 302)
  res.headers.set('Cache-Control', 'no-store')
  return res
}

/**
 * GET /api/auth/callback — Zitadel OIDC 回调。
 *
 * 认证链路（与奕升集成时建议三步齐全）：
 * 1. **Zitadel**：换票、`id_token` 校验、UserInfo → 得到可信 `sub` / 邮箱 / 显示名。
 * 2. **用户中心**（需 `USER_CENTER_API_URL`）：`POST …/api/internal/tenant-context` → 是否已绑租户、`tenant`（名称/slug）、`tenant.role`（帐号在租户内角色，同步到本地 `portal_tenant_role` / MC `role`）。
 * 3. **本地**：按 `sub`/邮箱匹配或自动建 `users`、写会话 Cookie，再经 `/auth/enter` 进入平台。
 *
 * 未配置用户中心时跳过第 2 步（仅 IdP + 本地，兼容单机部署）。若需禁止该旁路，设 `MC_ZITADEL_REQUIRE_USERCENTER=1`。
 */
export async function GET(request: NextRequest) {
  const rateCheck = oidcFlowLimiter(request)
  if (rateCheck) return rateCheck

  if (!oidcIsConfigured()) {
    return NextResponse.json({ error: 'OIDC 尚未配置完整' }, { status: 500 })
  }

  const code = String(request.nextUrl.searchParams.get('code') || '').trim()
  const state = String(request.nextUrl.searchParams.get('state') || '').trim()
  const oidcError = String(request.nextUrl.searchParams.get('error') || '').trim()
  const flowToken = request.cookies.get(OIDC_FLOW_COOKIE)?.value || ''

  const isSecureRequest = isRequestSecure(request)
  const clearFlow = (res: NextResponse) => {
    res.cookies.set(OIDC_FLOW_COOKIE, '', {
      ...getMcSessionCookieOptions({ maxAgeSeconds: 0, isSecureRequest, sameSite: 'lax' }),
    })
  }

  if (oidcError) {
    const res = redirectToLogin(request, { login_error: 'oidc_denied' })
    clearFlow(res)
    return res
  }
  if (!code || !state || !flowToken) {
    console.warn('[api/auth/callback] oidc_invalid_state: missing', {
      hasCode: Boolean(code),
      hasState: Boolean(state),
      hasFlowCookie: Boolean(flowToken),
    })
    const res = redirectToLogin(request, { login_error: 'oidc_invalid_state' })
    clearFlow(res)
    return res
  }

  const flow = verifyOidcFlowCookie(flowToken)
  if (!flow || flow.state !== state) {
    console.warn('[api/auth/callback] oidc_invalid_state: flow_cookie', {
      verified: Boolean(flow),
      stateMatch: flow ? flow.state === state : false,
    })
    const res = redirectToLogin(request, { login_error: 'oidc_invalid_state' })
    clearFlow(res)
    return res
  }

  try {
    const tokens = await exchangeCodeForTokens({ code, codeVerifier: flow.codeVerifier })
    const idClaims = await verifyIdToken(tokens.idToken, flow.nonce)
    const userInfo = await fetchOidcUserInfo(tokens.accessToken).catch(() => null)

    const emailRaw = userInfo?.email || idClaims.email || null
    const email = emailRaw ? String(emailRaw).toLowerCase().trim() : ''
    const sub = String(idClaims.sub || '').trim()
    const loginName =
      userInfo?.preferredUsername || idClaims.preferredUsername || email || sub
    const displayName = String(
      userInfo?.name || idClaims.name || email || loginName || sub || 'Zitadel User'
    ).trim()

    const zitadelRequireUsercenter = ['1', 'true', 'yes'].includes(
      String(process.env.MC_ZITADEL_REQUIRE_USERCENTER || '').trim().toLowerCase()
    )
    if (zitadelRequireUsercenter && !isUsercenterApiConfigured()) {
      console.warn('[api/auth/callback] MC_ZITADEL_REQUIRE_USERCENTER set but USER_CENTER_API_URL missing')
      const res = redirectToLogin(request, { login_error: 'usercenter_required' })
      clearFlow(res)
      return res
    }

    const ipAddress = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown'
    const userAgent = request.headers.get('user-agent') || undefined

    const tenantGate = await fetchUsercenterTenantContextIfConfigured({
      subject: sub,
      email: email || null,
      displayName,
    })

    if (tenantGate.configured && !tenantGate.ok) {
      console.warn('[api/auth/callback] usercenter tenant-context', tenantGate.error)
      const res = redirectToLogin(request, { login_error: 'tenant_gateway_failed' })
      clearFlow(res)
      return res
    }

    const autoProvisionOrgOnLogin = String(process.env.MC_AUTO_PROVISION_ORG_ON_LOGIN ?? '1').trim().toLowerCase() !== '0'
    let portalTenant: UsercenterPortalTenant | undefined =
      tenantGate.configured && tenantGate.ok && tenantGate.data.hasTenant
        ? tenantGate.data.tenant
        : undefined

    if (tenantGate.configured && tenantGate.ok && tenantGate.data.hasTenant !== true && autoProvisionOrgOnLogin) {
      const orgName = resolveAutoOrganizationName({ displayName, email })
      const orgSlug = slugFromOrganizationName(orgName, `org-${randomBytes(3).toString('hex')}`)
      try {
        const created = await createUsercenterTenant({
          subject: sub,
          email: email || null,
          displayName,
          name: orgName,
          slug: orgSlug,
        })
        portalTenant = {
          id: String(created.tenantId),
          name: orgName,
          slug: created.slug || orgSlug,
          role: 'owner',
        }
        logAuditEvent({
          action: 'zitadel_auto_provision_usercenter_tenant',
          actor: email || loginName,
          detail: { sub, orgName, tenantId: created.tenantId, slug: created.slug },
          ip_address: ipAddress,
          user_agent: userAgent,
        })
      } catch (autoErr) {
        console.warn('[api/auth/callback] auto create usercenter tenant failed', autoErr)
      }
    }

    if (tenantGate.configured && tenantGate.ok && tenantGate.data.hasTenant !== true && !portalTenant) {
      const returnTo =
        flow.returnTo && flow.returnTo.startsWith('/') && !flow.returnTo.startsWith('//') ? flow.returnTo : '/'

      logAuditEvent({
        action: 'zitadel_login_usercenter_no_tenant',
        actor: email || loginName,
        detail: { sub, reason: tenantGate.data.reason },
        ip_address: ipAddress,
        user_agent: userAgent,
      })

      const onboardingMode = resolveUsercenterOnboardingMode()
      if (onboardingMode === 'local') {
        const proofToken = signZitadelOnboardingProof({
          zitadelSub: sub,
          email: email || String(loginName || '').trim() || sub,
          displayName,
          returnTo,
        })
        const target = new URL('/login/tenant-onboarding', resolveRequestOrigin(request)).toString()
        const res = NextResponse.redirect(target, 302)
        res.headers.set('Cache-Control', 'no-store')
        res.cookies.set(MC_PENDING_ONBOARDING_COOKIE, proofToken, {
          ...getMcSessionCookieOptions({ maxAgeSeconds: 900, isSecureRequest, sameSite: 'lax' }),
        })
        clearFlow(res)
        return res
      }

      const portal = resolveUserCenterPortalBase()
      const mcOrigin = resolveRequestOrigin(request)
      if (!portal) {
        const res = redirectToLogin(request, { login_error: 'tenant_onboarding_no_portal' })
        clearFlow(res)
        return res
      }

      const target = buildUserCenterOnboardingRedirectUrl({
        portalBase: portal,
        subject: sub,
        email: email || String(loginName || '').trim() || sub,
        displayName,
        mcOrigin,
        returnTo,
        reason: tenantGate.data.reason,
      })
      const res = NextResponse.redirect(target, 302)
      res.headers.set('Cache-Control', 'no-store')
      clearFlow(res)
      return res
    }

    const db = getDatabase()
    const userLookupSql = `
      SELECT u.id, u.username, u.display_name, u.role, u.provider, u.email, u.avatar_url, u.is_approved,
             u.portal_tenant_role,
             u.created_at, u.updated_at, u.last_login_at, u.workspace_id, COALESCE(w.tenant_id, 1) as tenant_id
      FROM users u
      LEFT JOIN workspaces w ON w.id = u.workspace_id
      WHERE (u.provider = 'zitadel' AND u.provider_user_id = ?) OR lower(u.email) = ?
      ORDER BY u.id ASC
      LIMIT 1
    `
    type ZitadelUserRow = {
      id: number
      username: string
      display_name: string
      role: string
      provider: string | null
      email: string | null
      avatar_url: string | null
      is_approved: number
      portal_tenant_role: string | null
      workspace_id: number
      tenant_id: number
      created_at: number
      updated_at: number
      last_login_at: number | null
    }
    let row = db.prepare(userLookupSql).get(sub, email) as ZitadelUserRow | undefined

    const autoProvision =
      String(process.env.MC_USERCENTER_AUTO_PROVISION ?? '1').trim().toLowerCase() !== '0'

    if (!row && autoProvision && portalTenant) {
      const provision = provisionLocalUserFromUsercenterTenant({
        sub,
        email,
        displayName,
        portalTenant: {
          id: String(portalTenant.id || '').trim(),
          name: String(portalTenant.name || '').trim(),
          slug: String(portalTenant.slug || '').trim(),
          role: String(portalTenant.role || ''),
        },
      })
      if (!provision.ok) {
        console.warn('[api/auth/callback] usercenter local provision failed', provision.error)
        const res = redirectToLogin(request, { login_error: 'tenant_provision_failed' })
        clearFlow(res)
        return res
      }
      logAuditEvent({
        action: 'zitadel_usercenter_provision_user',
        actor: email || loginName,
        detail: { sub, userId: provision.userId, tenantId: provision.tenantId, created: provision.created },
        ip_address: ipAddress,
        user_agent: userAgent,
      })
      row = db.prepare(userLookupSql).get(sub, email) as ZitadelUserRow | undefined
    }

    if (!row) {
      try {
        const password = randomBytes(32).toString('hex')
        const base = deriveZitadelLocalUsername(email, sub)
        try {
          createUser(base, password, displayName, 'operator', {
            provider: 'zitadel',
            provider_user_id: sub,
            email: email || null,
            is_approved: 1,
          })
        } catch {
          createUser(`${base.slice(0, 48)}_${randomBytes(3).toString('hex')}`, password, displayName, 'operator', {
            provider: 'zitadel',
            provider_user_id: sub,
            email: email || null,
            is_approved: 1,
          })
        }
        row = db.prepare(userLookupSql).get(sub, email) as ZitadelUserRow | undefined
      } catch (e) {
        console.warn('[api/auth/callback] zitadel local user create failed', e)
      }
      if (!row) {
        const res = redirectToLogin(request, { login_error: 'oidc_failed' })
        clearFlow(res)
        return res
      }
      logAuditEvent({
        action: 'zitadel_auto_created_user',
        actor: email || loginName,
        detail: { sub, userId: row.id },
        ip_address: ipAddress,
        user_agent: userAgent,
      })
    } else if (Number(row.is_approved ?? 1) !== 1) {
      updateUser(row.id, { is_approved: 1 })
      row = { ...row, is_approved: 1 }
      logAuditEvent({
        action: 'zitadel_auto_approved_user',
        actor: row.username,
        actor_id: row.id,
        detail: { sub },
        ip_address: ipAddress,
        user_agent: userAgent,
      })
    }

    if (portalTenant && row) {
      const synced = syncExistingUserWithUsercenterPortal({
        userId: row.id,
        portalTenant: {
          id: String(portalTenant.id || '').trim(),
          name: String(portalTenant.name || '').trim(),
          slug: String(portalTenant.slug || '').trim(),
          role: String(portalTenant.role || ''),
        },
      })
      if (synced) {
        const refreshed = db.prepare(userLookupSql).get(sub, email) as ZitadelUserRow | undefined
        if (refreshed) row = refreshed
      }
    } else if (row && !tenantGate.configured && autoProvisionOrgOnLogin) {
      const orgName = resolveAutoOrganizationName({ displayName, email })
      const synced = ensureOrganizationBindingForUser({
        userId: row.id,
        organizationName: orgName,
        role: 'owner',
      })
      if (synced) {
        const refreshed = db.prepare(userLookupSql).get(sub, email) as ZitadelUserRow | undefined
        if (refreshed) row = refreshed
        logAuditEvent({
          action: 'zitadel_auto_provision_local_tenant',
          actor: email || loginName,
          detail: { sub, orgName, tenantId: synced.tenantId },
          ip_address: ipAddress,
          user_agent: userAgent,
        })
      }
    }

    db.prepare(`
      UPDATE users
      SET provider = 'zitadel', provider_user_id = ?, email = COALESCE(?, email), display_name = ?, updated_at = (unixepoch())
      WHERE id = ?
    `).run(sub, email || null, displayName, row.id)

    const { token, expiresAt } = createSession(row.id, ipAddress, userAgent, row.workspace_id ?? 1)

    logAuditEvent({
      action: 'login_zitadel',
      actor: row.username,
      actor_id: row.id,
      ip_address: ipAddress,
      user_agent: userAgent,
    })

    const returnTo = flow.returnTo && flow.returnTo.startsWith('/') && !flow.returnTo.startsWith('//')
      ? flow.returnTo
      : '/'
    const handoffNext = returnTo.startsWith('/auth/enter') ? '/' : returnTo
    const handoffUrl = new URL(`/auth/enter?next=${encodeURIComponent(handoffNext)}`, resolveRequestOrigin(request)).toString()

    const res = NextResponse.redirect(handoffUrl, 302)
    res.headers.set('Cache-Control', 'no-store')
    clearFlow(res)

    const cookieName = getMcSessionCookieName(isSecureRequest)
    res.cookies.set(cookieName, token, {
      ...getMcSessionCookieOptions({ maxAgeSeconds: expiresAt - Math.floor(Date.now() / 1000), isSecureRequest }),
    })

    res.cookies.set(OIDC_ID_TOKEN_COOKIE, tokens.idToken, {
      ...getMcSessionCookieOptions({ maxAgeSeconds: 3600, isSecureRequest }),
    })

    return res
  } catch (e) {
    console.error('[api/auth/callback]', e)
    const res = redirectToLogin(request, { login_error: 'oidc_failed' })
    clearFlow(res)
    res.cookies.set(OIDC_ID_TOKEN_COOKIE, '', {
      ...getMcSessionCookieOptions({ maxAgeSeconds: 0, isSecureRequest }),
    })
    return res
  }
}
