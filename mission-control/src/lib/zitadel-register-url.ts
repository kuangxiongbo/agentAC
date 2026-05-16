/**
 * Zitadel 自助注册页 URL（供 `/api/auth/sso` 与登录页「注册帐号」外链使用）。
 */
export function resolveZitadelRegisterUrl(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): string | null {
  const raw = String(env.ZITADEL_REGISTER_URL || env.NEXT_PUBLIC_SSO_REGISTER_URL || '').trim()
  if (raw) {
    try {
      const u = new URL(raw)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
      return u.toString()
    } catch {
      return null
    }
  }
  const issuer = String(env.ZITADEL_ISSUER || '').trim()
  if (!issuer) return null
  try {
    const base = issuer.endsWith('/') ? issuer.slice(0, -1) : issuer
    const u = new URL('/ui/login/register', `${base}/`)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}
