'use client'

import { useTranslations } from 'next-intl'
import { HealthRow, formatUptime, type DashboardData } from '../widget-primitives'

export function RuntimeHealthWidget({ data }: { data: DashboardData }) {
  const t = useTranslations('dashboardOverview')
  const { localOsStatus, claudeHealth, codexHealth, hermesHealth, mcHealth, memPct, systemStats } = data

  return (
    <div className="panel">
      <div className="panel-header"><h3 className="text-sm font-semibold">{t('runtimeHealthTitle')}</h3></div>
      <div className="panel-body space-y-3">
        <HealthRow label={t('localOs')} value={localOsStatus.value} status={localOsStatus.status} />
        <HealthRow label={t('claudeRuntime')} value={claudeHealth.value} status={claudeHealth.status} />
        <HealthRow label={t('codexRuntime')} value={codexHealth.value} status={codexHealth.status} />
        <HealthRow label={t('hermesRuntime')} value={hermesHealth.value} status={hermesHealth.status} />
        <HealthRow label={t('mcCore')} value={mcHealth.value} status={mcHealth.status} />
        {memPct != null && <HealthRow label={t('memory')} value={`${memPct}%`} status={memPct > 90 ? 'bad' : memPct > 70 ? 'warn' : 'good'} bar={memPct} />}
        {systemStats?.disk && <HealthRow label={t('disk')} value={systemStats.disk.usage || t('unknown')} status={parseInt(systemStats.disk.usage) > 90 ? 'bad' : 'good'} />}
        {systemStats?.uptime != null && <HealthRow label={t('uptime')} value={formatUptime(systemStats.uptime)} status="good" />}
      </div>
    </div>
  )
}
