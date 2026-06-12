export function resolveUserCenterSubscriptionsUrl(): string {
  const portal = String(process.env.USER_CENTER_PORTAL_URL || '').trim().replace(/\/$/, '')
  if (portal) return `${portal}/subscriptions`
  const api = String(process.env.USER_CENTER_API_URL || process.env.USERCENTER_ORIGIN || '').trim().replace(/\/$/, '')
  if (api) {
    try {
      return `${new URL(api).origin}/subscriptions`
    } catch {
      /* ignore */
    }
  }
  return 'https://user.1sheng.work/subscriptions'
}
