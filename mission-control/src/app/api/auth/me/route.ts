import { NextRequest, NextResponse } from 'next/server'
import { getUserFromRequest, updateUser, requireRole, destroyAllUserSessions, createSession, publicAuthUserFields } from '@/lib/auth'
import { logAuditEvent, getDatabase } from '@/lib/db'
import { resolveEffectiveLicense, resolveUserCenterSubscriptionsUrl } from '@/lib/effective-license'
import { setMaxEdgeClientsLimit } from '@/lib/bridge-server'
import { getProviderSubjectForUser } from '@/lib/license-resolve-context'
import { verifyPassword } from '@/lib/password'
import { getMcSessionCookieName, getMcSessionCookieOptions, isRequestSecure } from '@/lib/session-cookie'
import { logger } from '@/lib/logger'

export async function GET(request: Request) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const user = getUserFromRequest(request)

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const db = getDatabase()
  const orgRow = db
    .prepare(
      `SELECT t.id as tenant_id, t.display_name, t.slug
       FROM workspaces w
       JOIN tenants t ON t.id = w.tenant_id
       WHERE w.id = ?`
    )
    .get(user.workspace_id ?? 1) as { tenant_id: number; display_name: string; slug: string } | undefined
  const organization = orgRow
    ? { tenant_id: orgRow.tenant_id, display_name: orgRow.display_name, slug: orgRow.slug }
    : null

  const license = await resolveEffectiveLicense({
    tenantId: user.tenant_id,
    zitadelSub: getProviderSubjectForUser(user.id),
    portalTenantRole: user.portal_tenant_role,
    forceRefresh: true,
  })

  setMaxEdgeClientsLimit(license.entitlements.maxEdgeClients as number ?? 0)

  return NextResponse.json({
    user: {
      ...publicAuthUserFields(user),
      organization,
    },
    license: {
      allowed: license.allowed,
      licensed: license.licensed,
      source: license.source,
      reason: license.reason,
      entitlements: license.entitlements,
      expiresAt: license.expiresAt,
      requiresSubscription: license.requiresSubscription,
      appId: license.appId,
      displayName: license.displayName,
      subscriptionsUrl: resolveUserCenterSubscriptionsUrl(),
    },
  })
}

/**
 * PATCH /api/auth/me - Self-service password change and display name update.
 * Body: { current_password, new_password } and/or { display_name }
 */
export async function PATCH(request: NextRequest) {
  const user = getUserFromRequest(request)
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  // API key users (id=0) cannot change passwords
  if (user.id === 0) {
    return NextResponse.json({ error: 'API key users cannot change passwords' }, { status: 403 })
  }

  try {
    const { current_password, new_password, display_name } = await request.json()

    const updates: { password?: string; display_name?: string } = {}

    // Handle password change
    if (new_password) {
      if ((user.provider || 'local') !== 'local') {
        return NextResponse.json({ error: 'Password is managed by your identity provider' }, { status: 403 })
      }
      if (!current_password) {
        return NextResponse.json({ error: 'Current password is required' }, { status: 400 })
      }

      if (new_password.length < 12) {
        return NextResponse.json({ error: 'New password must be at least 12 characters' }, { status: 400 })
      }

      // Verify current password by fetching stored hash
      const { getDatabase } = await import('@/lib/db')
      const db = getDatabase()
      const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as any
      if (!row || !verifyPassword(current_password, row.password_hash)) {
        return NextResponse.json({ error: 'Current password is incorrect' }, { status: 403 })
      }

      updates.password = new_password
    }

    // Handle display name update
    if (display_name !== undefined) {
      if (!display_name.trim()) {
        return NextResponse.json({ error: 'Display name cannot be empty' }, { status: 400 })
      }
      updates.display_name = display_name.trim()
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No updates provided' }, { status: 400 })
    }

    const updated = updateUser(user.id, updates)
    if (!updated) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const ipAddress = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown'
    const userAgent = request.headers.get('user-agent') || undefined
    if (updates.password) {
      logAuditEvent({ action: 'password_change', actor: user.username, actor_id: user.id, ip_address: ipAddress })
      // Revoke all existing sessions and issue a fresh one for this request
      destroyAllUserSessions(user.id)
    }
    if (updates.display_name) {
      logAuditEvent({ action: 'profile_update', actor: user.username, actor_id: user.id, detail: { display_name: updates.display_name }, ip_address: ipAddress })
    }

    const db = getDatabase()
    const orgRow = db
      .prepare(
        `SELECT t.id as tenant_id, t.display_name, t.slug
         FROM workspaces w
         JOIN tenants t ON t.id = w.tenant_id
         WHERE w.id = ?`
      )
      .get(updated.workspace_id ?? 1) as { tenant_id: number; display_name: string; slug: string } | undefined
    const organization = orgRow
      ? { tenant_id: orgRow.tenant_id, display_name: orgRow.display_name, slug: orgRow.slug }
      : null

    const response = NextResponse.json({
      success: true,
      user: {
        ...publicAuthUserFields(updated),
        organization,
      },
    })

    // Issue a fresh session cookie after password change (old ones were just revoked)
    if (updates.password) {
      const { token, expiresAt } = createSession(user.id, ipAddress, userAgent, updated.workspace_id ?? 1)
      const isSecureRequest = isRequestSecure(request)
      const cookieName = getMcSessionCookieName(isSecureRequest)
      response.cookies.set(cookieName, token, {
        ...getMcSessionCookieOptions({ maxAgeSeconds: expiresAt - Math.floor(Date.now() / 1000), isSecureRequest }),
      })
    }

    return response
  } catch (error) {
    logger.error({ err: error }, 'PATCH /api/auth/me error')
    return NextResponse.json({ error: 'Failed to update profile' }, { status: 500 })
  }
}
