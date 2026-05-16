'use client'

import { useState, useEffect, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { StatRow, type DashboardData } from '../widget-primitives'
import { useNavigateToPanel } from '@/lib/navigation'

interface PostureInfo {
  score: number
  level: string
}

const postureBadge: Record<string, { className: string }> = {
  hardened: { className: 'bg-green-500/15 text-green-400' },
  secure: { className: 'bg-green-500/10 text-green-300' },
  'needs-attention': { className: 'bg-yellow-500/15 text-yellow-400' },
  'at-risk': { className: 'bg-red-500/15 text-red-400' },
}

export function SecurityAuditWidget({ data }: { data: DashboardData }) {
  const t = useTranslations('dashboardOverview')
  const { dbStats } = data
  const navigateToPanel = useNavigateToPanel()
  const [posture, setPosture] = useState<PostureInfo | null>(null)

  const fetchPosture = useCallback(async () => {
    try {
      const res = await fetch('/api/security-audit?timeframe=day')
      if (res.ok) {
        const json = await res.json()
        if (json.posture) setPosture(json.posture)
      }
    } catch {
      // Silent
    }
  }, [])

  useEffect(() => { fetchPosture() }, [fetchPosture])

  const badge = posture ? postureBadge[posture.level] || postureBadge['secure'] : null
  const badgeLabel = posture?.level === 'hardened'
    ? t('widgetSecurityHardened')
    : posture?.level === 'needs-attention'
      ? t('widgetSecurityNeedsAttention')
      : posture?.level === 'at-risk'
        ? t('widgetSecurityAtRisk')
        : t('widgetSecuritySecure')

  return (
    <div className="panel">
      <div className="panel-header">
        <h3 className="text-sm font-semibold">{t('widgetSecurityTitle')}</h3>
        {posture && badge && (
          <span className={`text-2xs px-1.5 py-0.5 rounded font-medium ${badge.className}`}>
            {posture.score} - {badgeLabel}
          </span>
        )}
      </div>
      <div className="panel-body space-y-3">
        <StatRow label={t('widgetSecurityAuditEvents24h')} value={dbStats?.audit.day ?? 0} />
        <StatRow label={t('widgetSecurityAuditEvents7d')} value={dbStats?.audit.week ?? 0} />
        <StatRow label={t('widgetSecurityLoginFailures24h')} value={dbStats?.audit.loginFailures ?? 0} alert={dbStats ? dbStats.audit.loginFailures > 0 : false} />
        <StatRow label={t('widgetSecurityUnreadNotifications')} value={dbStats?.notifications.unread ?? 0} alert={(dbStats?.notifications.unread ?? 0) > 0} />
        <button
          onClick={() => navigateToPanel('security')}
          className="w-full text-center text-xs text-primary hover:text-primary/80 py-1.5 mt-1 border border-border/50 rounded hover:bg-secondary transition-colors"
        >
          {t('widgetSecurityOpenPanel')}
        </button>
      </div>
    </div>
  )
}
