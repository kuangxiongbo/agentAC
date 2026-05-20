import { getDatabase } from './db'

/** OIDC subject（Zitadel sub 等），用于用户中心在线校验 */
export function getProviderSubjectForUser(userId: number): string | null {
  if (!Number.isFinite(userId) || userId < 1) return null
  const row = getDatabase()
    .prepare(`SELECT provider, provider_user_id FROM users WHERE id = ? LIMIT 1`)
    .get(userId) as { provider?: string | null; provider_user_id?: string | null } | undefined
  const sub = row?.provider_user_id != null ? String(row.provider_user_id).trim() : ''
  if (!sub) return null
  const provider = String(row?.provider || '').trim().toLowerCase()
  if (provider === 'zitadel' || provider === 'google') return sub
  return sub
}
