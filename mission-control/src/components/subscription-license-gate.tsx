'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { useAgentCenterStore, type LicenseSnapshot } from '@/store'

function isSubscriptionBlocked(license: LicenseSnapshot | null): boolean {
  if (!license) return false
  return license.requiresSubscription === true && license.allowed !== true
}

export function SubscriptionLicenseGate() {
  const t = useTranslations('licenseGate')
  const { license } = useAgentCenterStore()

  if (!isSubscriptionBlocked(license)) return null

  const subsUrl = license?.subscriptionsUrl || 'https://user.1sheng.work/subscriptions'
  const displayName = license?.displayName || t('defaultAppName')

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/95 backdrop-blur-sm p-6">
      <div className="max-w-md w-full rounded-xl border border-border bg-card p-6 shadow-xl text-center space-y-4">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          {t('badge')}
        </p>
        <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('body', { app: displayName })}
        </p>
        <p className="text-xs text-muted-foreground/80 font-mono">
          {t('reason', { reason: license?.reason || 'unsubscribed', source: license?.source || 'default' })}
        </p>
        <div className="flex flex-col gap-2 pt-2">
          <Button asChild>
            <a href={subsUrl} target="_blank" rel="noopener noreferrer">
              {t('subscribeCta')}
            </a>
          </Button>
        </div>
      </div>
    </div>
  )
}

export function useHumanWatchEntitled(): boolean {
  const { license } = useAgentCenterStore()
  if (!license) return true
  if (license.requiresSubscription && !license.allowed) return false
  return Boolean(license.entitlements?.enableHumanWatch)
}

export function HumanWatchEntitlementNotice({ className = '' }: { className?: string }) {
  const t = useTranslations('licenseGate')
  const { license } = useAgentCenterStore()
  const entitled = useHumanWatchEntitled()

  if (entitled) return null

  const subsUrl = license?.subscriptionsUrl || 'https://user.1sheng.work/subscriptions'

  return (
    <div className={`rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200 ${className}`}>
      <p className="font-medium">{t('humanWatchTitle')}</p>
      <p className="mt-1 text-amber-200/80">{t('humanWatchBody')}</p>
      <a
        href={subsUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block mt-2 text-primary hover:underline"
      >
        {t('subscribeCta')}
      </a>
    </div>
  )
}
