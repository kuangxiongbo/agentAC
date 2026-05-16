'use client'

import { useTranslations } from 'next-intl'
import { StatRow, type DashboardData } from '../widget-primitives'

export function GithubSignalWidget({ data }: { data: DashboardData }) {
  const t = useTranslations('dashboardOverview')
  const { githubStats, isGithubLoading } = data
  const hasGithubStats = Boolean(githubStats?.configured !== false && githubStats?.user && githubStats?.repos)

  return (
    <div className="panel">
      <div className="panel-header">
        <h3 className="text-sm font-semibold">{t('widgetGithubTitle')}</h3>
        {hasGithubStats && <span className="text-2xs text-muted-foreground font-mono-tight">@{githubStats.user.login}</span>}
      </div>
      <div className="panel-body space-y-3">
        {hasGithubStats ? (
          <>
            <StatRow label={t('widgetGithubActiveRepos')} value={githubStats.repos.total} />
            <StatRow label={t('widgetGithubVisibility')} value={`${githubStats.repos.public} / ${githubStats.repos.private}`} />
            <StatRow label={t('widgetGithubOpenIssues')} value={githubStats.repos.total_open_issues} />
            <StatRow label={t('widgetGithubStars')} value={githubStats.repos.total_stars} />
          </>
        ) : (
          <div className="text-center py-4">
            <p className="text-xs text-muted-foreground">{isGithubLoading ? t('widgetGithubLoading') : t('widgetGithubNoToken')}</p>
            {!isGithubLoading && <p className="text-2xs text-muted-foreground/60 mt-1">{t('widgetGithubSetToken')}</p>}
          </div>
        )}
      </div>
    </div>
  )
}
