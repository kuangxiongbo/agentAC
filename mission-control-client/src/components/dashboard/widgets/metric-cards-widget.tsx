'use client'

import { useTranslations } from 'next-intl'
import {
  MetricCard,
  SessionIcon,
  GatewayIcon,
  AgentIcon,
  TaskIcon,
  ActivityIconMini,
  TokenIcon,
  CostIcon,
  formatTokensShort,
  type DashboardData,
} from '../widget-primitives'

export function MetricCardsWidget({ data }: { data: DashboardData }) {
  const t = useTranslations('dashboardOverview')
  const {
    isLocal,
    isClaudeLoading,
    isSessionsLoading,
    isSystemLoading,
    claudeActive,
    codexActive,
    hermesActive,
    claudeStats,
    claudeLocalSessions,
    codexLocalSessions,
    hermesLocalSessions,
    hermesCronJobCount,
    systemLoad,
    memPct,
    diskPct,
    connection,
    activeSessions,
    sessions,
    onlineAgents,
    dbStats,
    agents,
    backlogCount,
    runningTasks,
    errorCount,
    subscriptionLabel,
    subscriptionPrice,
  } = data

  if (isLocal) {
    return (
      <section className="grid grid-cols-2 xl:grid-cols-6 gap-3">
        <MetricCard
          label={t('metricClaude')}
          value={isClaudeLoading ? '...' : claudeActive}
          total={isClaudeLoading ? undefined : (claudeStats?.total_sessions ?? claudeLocalSessions.length)}
          subtitle={t('activeSessionsSubtitle')}
          icon={<SessionIcon />}
          color="blue"
        />
        <MetricCard
          label={t('metricCodex')}
          value={isSessionsLoading ? '...' : codexActive}
          total={isSessionsLoading ? undefined : codexLocalSessions.length}
          subtitle={t('activeSessionsSubtitle')}
          icon={<SessionIcon />}
          color="green"
        />
        <MetricCard
          label={t('metricHermes')}
          value={isSessionsLoading ? '...' : hermesActive}
          total={isSessionsLoading ? undefined : hermesLocalSessions.length}
          subtitle={hermesCronJobCount > 0 ? t('hermesActiveCronSubtitle', { active: hermesActive, cron: hermesCronJobCount }) : t('activeSessionsSubtitle')}
          icon={<SessionIcon />}
          color="purple"
        />
        <MetricCard
          label={t('metricSystemLoad')}
          value={isSystemLoading ? '...' : `${systemLoad}%`}
          subtitle={t('memDiskSubtitle', { mem: memPct ?? '-', disk: Number.isFinite(diskPct) ? `${diskPct}%` : '-' })}
          icon={<ActivityIconMini />}
          color={systemLoad > 85 ? 'red' : 'purple'}
        />
        <MetricCard
          label={t('metricTokens')}
          value={isClaudeLoading ? '...' : formatTokensShort((claudeStats?.total_input_tokens ?? 0) + (claudeStats?.total_output_tokens ?? 0))}
          subtitle={isClaudeLoading ? undefined : t('inOutSubtitle', { input: formatTokensShort(claudeStats?.total_input_tokens ?? 0), output: formatTokensShort(claudeStats?.total_output_tokens ?? 0) })}
          icon={<TokenIcon />}
          color="purple"
        />
        <MetricCard
          label={t('metricCost')}
          value={isClaudeLoading ? '...' : (subscriptionLabel ? (subscriptionPrice ? `$${subscriptionPrice}/mo` : t('included')) : `$${(claudeStats?.total_estimated_cost ?? 0).toFixed(2)}`)}
          subtitle={subscriptionLabel ? t('planSubtitle', { plan: subscriptionLabel }) : t('estimatedSubtitle')}
          icon={<CostIcon />}
          color={errorCount > 0 ? 'red' : 'green'}
        />
      </section>
    )
  }

  return (
    <section className="grid grid-cols-2 xl:grid-cols-5 gap-3">
      <MetricCard label={t('gateway')} value={connection.isConnected ? t('online') : t('offline')} subtitle={t('transportStatus')} icon={<GatewayIcon />} color={connection.isConnected ? 'green' : 'red'} />
      <MetricCard label={t('metricSessions')} value={activeSessions} total={sessions.length} subtitle={t('activeTotalSubtitle')} icon={<SessionIcon />} color="blue" />
      <MetricCard label={t('metricAgentCapacity')} value={onlineAgents} subtitle={t('totalSuffix', { count: dbStats?.agents.total ?? agents.length })} icon={<AgentIcon />} color="green" />
      <MetricCard label={t('metricQueue')} value={backlogCount} subtitle={t('runningSuffix', { count: runningTasks })} icon={<TaskIcon />} color={backlogCount > 12 ? 'red' : 'purple'} />
      <MetricCard label={t('metricSystemLoad')} value={isSystemLoading ? '...' : `${systemLoad}%`} subtitle={t('errorsSuffixCompact', { count: errorCount })} icon={<ActivityIconMini />} color={systemLoad > 85 || errorCount > 0 ? 'red' : 'blue'} />
    </section>
  )
}
