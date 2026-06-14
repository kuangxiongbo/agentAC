'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { useAgentCenterStore } from '@/store'
import { useLocalCliElevationEntitled } from '@/components/subscription-license-gate'

type ElevationButtonProps = {
  elevated: boolean
  onElevatedChange: (next: boolean) => void
  disabled?: boolean
  size?: 'sm' | 'default'
  className?: string
}

export function LocalCliElevationButton({
  elevated,
  onElevatedChange,
  disabled,
  size = 'default',
  className = '',
}: ElevationButtonProps) {
  const t = useTranslations('chat')
  const { license } = useAgentCenterStore()
  const storeEntitled = useLocalCliElevationEntitled()
  const [remoteEntitled, setRemoteEntitled] = useState<boolean | null>(null)
  const [checkingRemoteEntitlement, setCheckingRemoteEntitlement] = useState(!license)
  const [subscribeHint, setSubscribeHint] = useState(false)

  const subscriptionsUrl = license?.subscriptionsUrl || 'https://user.1sheng.work/subscriptions'
  const entitled = license ? storeEntitled : Boolean(remoteEntitled)
  const checkingEntitlement = !license && checkingRemoteEntitlement

  useEffect(() => {
    if (license) {
      setCheckingRemoteEntitlement(false)
      return
    }
    let cancelled = false
    setCheckingRemoteEntitlement(true)
    void fetch('/api/local-cli/elevation-entitled', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return
        setRemoteEntitled(Boolean(data.entitled))
      })
      .catch(() => {
        if (!cancelled) setRemoteEntitled(false)
      })
      .finally(() => {
        if (!cancelled) setCheckingRemoteEntitlement(false)
      })
    return () => {
      cancelled = true
    }
  }, [license])

  const handleClick = useCallback(() => {
    if (checkingEntitlement) return
    if (!entitled) {
      setSubscribeHint(true)
      window.setTimeout(() => setSubscribeHint(false), 6000)
      return
    }
    onElevatedChange(!elevated)
  }, [checkingEntitlement, entitled, elevated, onElevatedChange])

  const iconSize = size === 'sm' ? 12 : 14

  return (
    <div className={`relative flex flex-col items-end ${className}`}>
      <Button
        type="button"
        onClick={handleClick}
        disabled={disabled || checkingEntitlement}
        variant={elevated ? 'default' : 'ghost'}
        size={size === 'sm' ? 'icon-sm' : 'icon-sm'}
        className={`rounded-lg flex-shrink-0 ${
          elevated
            ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 hover:bg-amber-500/30'
            : checkingEntitlement
              ? 'text-muted-foreground/40'
            : entitled
              ? 'text-muted-foreground hover:text-amber-300 hover:bg-amber-500/10'
              : 'text-muted-foreground/50 hover:text-muted-foreground'
        }`}
        title={checkingEntitlement ? t('localCliElevationCheckingTitle') : entitled ? t('localCliElevationTitle') : t('localCliElevationSubscribeTitle')}
      >
        <svg width={iconSize} height={iconSize} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M8 1.5l4.4 1.7v3.3c0 3.1-1.8 5.9-4.4 7-2.6-1.1-4.4-3.9-4.4-7V3.2L8 1.5z" />
          <path d="M8 5.4v3.9" />
          <path d="M6.5 6.9h3" />
        </svg>
      </Button>
      {subscribeHint && (
        <div className="absolute bottom-full right-0 mb-2 w-56 rounded-lg border border-amber-500/30 bg-card px-3 py-2 text-[11px] text-amber-100 shadow-xl z-20">
          <p>{t('localCliElevationSubscribeBody')}</p>
          <a
            href={subscriptionsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-block text-primary hover:underline"
          >
            {t('localCliElevationSubscribeCta')}
          </a>
        </div>
      )}
    </div>
  )
}
