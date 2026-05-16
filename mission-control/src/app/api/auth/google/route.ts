import { randomBytes } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { createSession, createUser, updateUser, publicAuthUserFields } from '@/lib/auth'
import { getDatabase, logAuditEvent } from '@/lib/db'
import { verifyGoogleIdToken } from '@/lib/google-auth'
import { getMcSessionCookieName, getMcSessionCookieOptions, isRequestSecure } from '@/lib/session-cookie'
import { loginLimiter } from '@/lib/rate-limit'
import { deriveZitadelLocalUsername } from '@/lib/usercenter-provision-local'

export async function POST(request: NextRequest) {
  const rateCheck = loginLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const body = await request.json().catch(() => ({}))
    const credential = String(body?.credential || '')
    const profile = await verifyGoogleIdToken(credential)

    const db = getDatabase()
    const email = String(profile.email || '').toLowerCase().trim()
    const sub = String(profile.sub || '').trim()
    const displayName = String(profile.name || email.split('@')[0] || 'Google User').trim()
    const avatar = profile.picture ? String(profile.picture) : null

    const lookupSql = `
      SELECT u.id, u.username, u.display_name, u.role, u.provider, u.email, u.avatar_url, u.is_approved,
             u.portal_tenant_role,
             u.created_at, u.updated_at, u.last_login_at, u.workspace_id, COALESCE(w.tenant_id, 1) as tenant_id
      FROM users u
      LEFT JOIN workspaces w ON w.id = u.workspace_id
      WHERE (u.provider = 'google' AND u.provider_user_id = ?) OR lower(u.email) = ?
      ORDER BY u.id ASC
      LIMIT 1
    `

    let row = db.prepare(lookupSql).get(sub, email) as any

    const ipAddress = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown'
    const userAgent = request.headers.get('user-agent') || undefined

    if (!row) {
      const password = randomBytes(32).toString('hex')
      const base = deriveZitadelLocalUsername(email, sub)
      try {
        createUser(base, password, displayName, 'operator', {
          provider: 'google',
          provider_user_id: sub,
          email,
          avatar_url: avatar,
          is_approved: 1,
        })
      } catch {
        createUser(`${base.slice(0, 48)}_${randomBytes(3).toString('hex')}`, password, displayName, 'operator', {
          provider: 'google',
          provider_user_id: sub,
          email,
          avatar_url: avatar,
          is_approved: 1,
        })
      }
      row = db.prepare(lookupSql).get(sub, email) as any
      if (!row) {
        return NextResponse.json({ error: 'Failed to create local user for Google login' }, { status: 500 })
      }
      logAuditEvent({
        action: 'google_auto_created_user',
        actor: email,
        detail: { sub, userId: row.id },
        ip_address: ipAddress,
        user_agent: userAgent,
      })
    } else if (Number(row.is_approved ?? 1) !== 1) {
      updateUser(row.id, { is_approved: 1 })
      row = { ...row, is_approved: 1 }
      logAuditEvent({
        action: 'google_auto_approved_user',
        actor: row.username,
        actor_id: row.id,
        detail: { email, sub },
        ip_address: ipAddress,
        user_agent: userAgent,
      })
    }

    db.prepare(`
      UPDATE users
      SET provider = 'google', provider_user_id = ?, email = ?, display_name = ?, avatar_url = COALESCE(?, avatar_url), updated_at = (unixepoch())
      WHERE id = ?
    `).run(sub, email, displayName, avatar, row.id)

    const { token, expiresAt } = createSession(row.id, ipAddress, userAgent, row.workspace_id ?? 1)

    logAuditEvent({ action: 'login_google', actor: row.username, actor_id: row.id, ip_address: ipAddress, user_agent: userAgent })

    const response = NextResponse.json({
      user: publicAuthUserFields(row),
    })

    const isSecureRequest = isRequestSecure(request)
    const cookieName = getMcSessionCookieName(isSecureRequest)

    response.cookies.set(cookieName, token, {
      ...getMcSessionCookieOptions({ maxAgeSeconds: expiresAt - Math.floor(Date.now() / 1000), isSecureRequest }),
    })

    return response
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Google login failed' }, { status: 400 })
  }
}
