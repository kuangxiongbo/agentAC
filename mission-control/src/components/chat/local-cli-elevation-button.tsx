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
  const [subscribeHint, setSubscribeHint] = useState(false)

  const subscriptionsUrl = license?.subscriptionsUrl || 'https://user.1sheng.work/subscriptions'
  const entitled = license ? storeEntitled : (remoteEntitled ?? false)

  useEffect(() => {
    if (license) return
    let cancelled = false
    void fetch('/api/local-cli/elevation-entitled', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return
        setRemoteEntitled(Boolean(data.entitled))
      })
      .catch(() => {
        if (!cancelled) setRemoteEntitled(false)
      })
    return () => {
      cancelled = true
    }
  }, [license])

  const handleClick = useCallback(() => {
    if (!entitled) {
      setSubscribeHint(true)
      window.setTimeout(() => setSubscribeHint(false), 6000)
      return
    }
    onElevatedChange(!elevated)
  }, [entitled, elevated, onElevatedChange])

  const iconSize = size === 'sm' ? 12 : 14

  return (
    <div className={`relative flex flex-col items-end ${className}`}>
      <Button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        variant={elevated ? 'default' : 'ghost'}
        size={size === 'sm' ? 'icon-sm' : 'icon-sm'}
        className={`rounded-lg flex-shrink-0 ${
          elevated
            ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 hover:bg-amber-500/30'
            : entitled
              ? 'text-muted-foreground hover:text-amber-300 hover:bg-amber-500/10'
              : 'text-muted-foreground/50 hover:text-muted-foreground'
        }`}
        title={entitled ? t('localCliElevationTitle') : t('localCliElevationSubscribeTitle')}
      >
        <svg width={iconSize} height={iconSize} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 1.5l1.6 3.2 3.6.5-2.6 2.5.6 3.6L8 9.8l-3.2 1.5.6-3.6-2.6-2.5 3.6-.5L8 1.5z" />
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
