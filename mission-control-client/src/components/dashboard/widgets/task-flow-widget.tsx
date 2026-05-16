'use client'

import { useTranslations } from 'next-intl'
import { StatRow, type DashboardData } from '../widget-primitives'

export function TaskFlowWidget({ data }: { data: DashboardData }) {
  const t = useTranslations('dashboardOverview')
  const { inboxCount, assignedCount, runningTasks, reviewCount, doneCount, backlogCount } = data

  return (
    <div className="panel">
      <div className="panel-header"><h3 className="text-sm font-semibold">{t('widgetTaskFlowTitle')}</h3></div>
      <div className="panel-body grid grid-cols-2 gap-3">
        <StatRow label={t('widgetTaskFlowInbox')} value={inboxCount} />
        <StatRow label={t('widgetTaskFlowAssigned')} value={assignedCount} />
        <StatRow label={t('widgetTaskFlowInProgress')} value={runningTasks} />
        <StatRow label={t('widgetTaskFlowReview')} value={reviewCount} />
        <StatRow label={t('widgetTaskFlowDone')} value={doneCount} />
        <StatRow label={t('widgetTaskFlowBacklog')} value={backlogCount} alert={backlogCount > 12} />
      </div>
    </div>
  )
}
