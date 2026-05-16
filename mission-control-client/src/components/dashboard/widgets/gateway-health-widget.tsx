'use client'

import { useTranslations } from 'next-intl'
import { HealthRow, type DashboardData } from '../widget-primitives'

export function GatewayHealthWidget({ data }: { data: DashboardData }) {
  const t = useTranslations('dashboardOverview')
  const { connection, sessions, errorCount, backlogCount, memPct, systemStats, gatewayHealthStatus } = data

  return (
    <div className="panel">
      <div className="panel-header"><h3 className="text-sm font-semibold">{t('gatewayHealthTitle')}</h3></div>
      <div className="panel-body space-y-3">
        <HealthRow label={t('gateway')} value={connection.isConnected ? t('connected') : t('disconnected')} status={gatewayHealthStatus} />
        <HealthRow label={t('trafficSessions')} value={`${sessions.length}`} status={sessions.length > 0 ? 'good' : 'warn'} />
        <HealthRow label={t('errors24h')} value={`${errorCount}`} status={errorCount > 0 ? 'warn' : 'good'} />
        <HealthRow label={t('saturationQueue')} value={`${backlogCount}`} status={backlogCount > 16 ? 'bad' : backlogCount > 8 ? 'warn' : 'good'} />
        {memPct != null && <HealthRow label={t('memory')} value={`${memPct}%`} status={memPct > 90 ? 'bad' : memPct > 70 ? 'warn' : 'good'} bar={memPct} />}
        {systemStats?.disk && <HealthRow label={t('disk')} value={systemStats.disk.usage || t('unknown')} status={parseInt(systemStats.disk.usage) > 90 ? 'bad' : 'good'} />}
      </div>
    </div>
  )
}
