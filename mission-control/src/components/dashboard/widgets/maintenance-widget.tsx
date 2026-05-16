'use client'

import { useTranslations } from 'next-intl'
import { StatRow, formatBytes, type DashboardData } from '../widget-primitives'

export function MaintenanceWidget({ data }: { data: DashboardData }) {
  const t = useTranslations('dashboardOverview')
  const { dbStats } = data

  return (
    <div className="panel">
      <div className="panel-header"><h3 className="text-sm font-semibold">{t('widgetMaintenanceTitle')}</h3></div>
      <div className="panel-body space-y-3">
        {dbStats?.backup ? (
          <>
            <StatRow label={t('widgetMaintenanceLatestBackup')} value={dbStats.backup.age_hours < 1 ? t('widgetMaintenanceLessThanHourAgo') : t('widgetMaintenanceHoursAgo', { hours: dbStats.backup.age_hours })} alert={dbStats.backup.age_hours > 24} />
            <StatRow label={t('widgetMaintenanceBackupSize')} value={formatBytes(dbStats.backup.size)} />
          </>
        ) : (
          <StatRow label={t('widgetMaintenanceLatestBackup')} value={t('widgetMaintenanceNone')} alert />
        )}
        <StatRow label={t('widgetMaintenanceActivePipelines')} value={dbStats?.pipelines.active ?? 0} />
        <StatRow label={t('widgetMaintenancePipelineRuns24h')} value={dbStats?.pipelines.recentDay ?? 0} />
      </div>
    </div>
  )
}
