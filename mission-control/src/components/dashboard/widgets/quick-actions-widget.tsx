'use client'

import { useTranslations } from 'next-intl'
import {
  QuickAction,
  SpawnActionIcon,
  LogActionIcon,
  TaskActionIcon,
  MemoryActionIcon,
  SessionIcon,
  PipelineActionIcon,
  type DashboardData,
} from '../widget-primitives'

export function QuickActionsWidget({ data }: { data: DashboardData }) {
  const t = useTranslations('dashboardOverview')
  const { isLocal, navigateToPanel } = data

  return (
    <section className="grid grid-cols-2 lg:grid-cols-5 gap-2">
      {!isLocal && <QuickAction label={t('widgetQuickSpawnAgent')} desc={t('widgetQuickSpawnAgentDesc')} tab="spawn" icon={<SpawnActionIcon />} onNavigate={navigateToPanel} />}
      <QuickAction label={t('widgetQuickViewLogs')} desc={t('widgetQuickViewLogsDesc')} tab="logs" icon={<LogActionIcon />} onNavigate={navigateToPanel} />
      <QuickAction label={t('widgetQuickTaskBoard')} desc={t('widgetQuickTaskBoardDesc')} tab="tasks" icon={<TaskActionIcon />} onNavigate={navigateToPanel} />
      <QuickAction label={t('widgetQuickMemory')} desc={t('widgetQuickMemoryDesc')} tab="memory" icon={<MemoryActionIcon />} onNavigate={navigateToPanel} />
      {isLocal
        ? <QuickAction label={t('widgetQuickSessions')} desc={t('widgetQuickSessionsDesc')} tab="sessions" icon={<SessionIcon />} onNavigate={navigateToPanel} />
        : <QuickAction label={t('widgetQuickOrchestration')} desc={t('widgetQuickOrchestrationDesc')} tab="agents" icon={<PipelineActionIcon />} onNavigate={navigateToPanel} />}
    </section>
  )
}
