'use client'

import { useMemo } from 'react'
import { useAgentCenterStore } from '@/store'
import { HumanWatchEventsTab } from '@/components/panels/human-watch-events-tab'

export function HumanWatchPanel() {
  const { clientName, agents } = useAgentCenterStore()

  const stewardAgents = useMemo(
    () =>
      agents.filter((agent) => {
        const role = String(agent.role || '').toLowerCase()
        return role === 'human-watch' || role === 'human_watch'
      }),
    [agents],
  )

  return (
    <div className="p-4 md:p-6 max-w-5xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">人工值守</h1>
        <p className="text-sm text-muted-foreground mt-1">
          服务端创建值守智能体，事件通过平台同步到本地，由本地值守会话查看、回复与审批。
        </p>
      </div>

      <section className="rounded-xl border border-border/70 bg-card p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>当前客户端：{clientName || '-'}</span>
          <span>值守智能体：{stewardAgents.length}</span>
        </div>

        {stewardAgents.length > 0 ? (
          <ul className="space-y-2">
            {stewardAgents.map((agent) => (
              <li key={agent.id} className="rounded-lg border border-border/60 bg-surface-1/40 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{agent.name}</span>
                  <span className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-[11px] text-cyan-300">
                    值守
                  </span>
                  <span className="text-[11px] text-muted-foreground">{agent.framework || 'unknown'}</span>
                  <span className="text-[11px] text-muted-foreground">{agent.status}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">当前本地还没有同步到值守智能体。</p>
        )}
      </section>

      <section className="rounded-xl border border-border/70 bg-card p-4 space-y-3">
        <h2 className="text-sm font-semibold text-foreground">待介入事件</h2>
        <p className="text-xs text-muted-foreground">
          这里展示服务端结构化下发的值守事件。处理动作会回写到服务端，由平台统一审计。
        </p>
        <HumanWatchEventsTab />
      </section>
    </div>
  )
}
