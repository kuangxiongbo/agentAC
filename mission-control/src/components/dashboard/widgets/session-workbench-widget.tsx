'use client'

import { useTranslations } from 'next-intl'
import type { DashboardData } from '../widget-primitives'

export function SessionWorkbenchWidget({ data }: { data: DashboardData }) {
  const t = useTranslations('dashboardOverview')
  const { isLocal, sessions, isSessionsLoading, openSession } = data

  return (
    <div className="panel">
      <div className="panel-header">
        <h3 className="text-sm font-semibold">{isLocal ? t('sessionWorkbenchTitle') : t('sessionRouterTitle')}</h3>
        <span className="text-2xs text-muted-foreground font-mono-tight">{sessions.length}</span>
      </div>
      <div className="divide-y divide-border/50 max-h-80 overflow-y-auto">
        {sessions.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-xs text-muted-foreground">
              {isSessionsLoading
                ? t('loadingSessions')
                : isLocal
                  ? t('noActiveSessions')
                  : t('noGatewaySessions')}
            </p>
            <p className="text-2xs text-muted-foreground/60 mt-1">
              {isLocal
                ? t('startLocalSessionHint')
                : t('gatewaySessionHint')}
            </p>
          </div>
        ) : (
          sessions.slice(0, 10).map((session) => (
            <div key={session.id} className="px-4 py-2.5 hover:bg-secondary/20 transition-smooth">
              <button
                type="button"
                onClick={() => openSession(session)}
                className="w-full text-left flex items-center gap-3"
              >
                <div className={`w-2 h-2 rounded-full shrink-0 ${session.active ? 'bg-green-500' : 'bg-muted-foreground/30'}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium truncate font-mono-tight">{session.key || session.id}</div>
                  <div className="text-2xs text-muted-foreground">
                    {session.kind === 'codex-cli' ? t('sessionKindCodex') : session.kind === 'claude-code' ? t('sessionKindClaude') : session.kind === 'hermes' ? t('sessionKindHermes') : session.kind} · {session.model?.split('/').pop() || t('unknown')}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-2xs font-mono-tight text-muted-foreground">{session.tokens}</div>
                  <div className="text-2xs text-muted-foreground">{session.age}</div>
                </div>
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
