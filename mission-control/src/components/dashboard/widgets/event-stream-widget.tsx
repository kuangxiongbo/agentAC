'use client'

import { useTranslations } from 'next-intl'
import { LogRow, type DashboardData } from '../widget-primitives'

export function EventStreamWidget({ data }: { data: DashboardData }) {
  const t = useTranslations('dashboardOverview')
  const { isLocal, mergedRecentLogs, recentErrorLogs, isSessionsLoading } = data

  return (
    <div className="panel">
      <div className="panel-header">
        <h3 className="text-sm font-semibold">{isLocal ? t('eventStreamLocalTitle') : t('eventStreamGatewayTitle')}</h3>
        <span className="text-2xs text-muted-foreground font-mono-tight">
          {isLocal ? mergedRecentLogs.length : t('errorsSuffix', { count: recentErrorLogs })}
        </span>
      </div>
      <div className="divide-y divide-border/50 max-h-80 overflow-y-auto">
        {mergedRecentLogs.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-xs text-muted-foreground">
              {isSessionsLoading ? t('loadingLogs') : t('noLogsYet')}
            </p>
            <p className="text-2xs text-muted-foreground/60 mt-1">
              {isLocal ? t('localEventHint') : t('gatewayEventHint')}
            </p>
          </div>
        ) : (
          mergedRecentLogs.map((log) => <LogRow key={log.id} log={log} />)
        )}
      </div>
    </div>
  )
}
