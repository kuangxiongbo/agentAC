'use client'

import { useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { buildDefaultBindingRulesOverride } from '@/lib/human-watch-defaults'

type RulesOverride = Record<string, unknown>

function formatRulesSummary(rules: RulesOverride): { label: string; value: string }[] {
  const idle = rules.idle_timeout_seconds
  const stuck = Array.isArray(rules.stuck_signals) ? rules.stuck_signals.join(', ') : '—'
  const patterns = Array.isArray(rules.confirmation_patterns)
    ? `${(rules.confirmation_patterns as string[]).length} 条`
    : '—'
  const combo = rules.require_combination === false ? '否（满足其一）' : '是（空闲 + 卡住信号）'
  const grace = rules.grace_after_prompt_seconds
  const maxHour = rules.max_interventions_per_hour
  const prompt =
    typeof rules.prompt_template === 'string'
      ? rules.prompt_template.slice(0, 80) + (rules.prompt_template.length > 80 ? '…' : '')
      : '—'

  return [
    { label: 'L1 空闲超时', value: `${idle ?? 90} 秒` },
    { label: 'L2/L3 卡住信号', value: stuck },
    { label: '确认话术匹配', value: patterns },
    { label: '组合触发', value: combo },
    { label: '干预后静默期', value: `${grace ?? 30} 秒` },
    { label: '每小时上限', value: `${maxHour ?? 6} 次` },
    { label: '默认跟进话术', value: prompt },
  ]
}

export function HumanWatchRulesConfig({
  rulesOverride,
  compact = false,
}: {
  rulesOverride?: RulesOverride | null
  compact?: boolean
}) {
  const t = useTranslations('humanWatch')
  const rules = useMemo(
    () => ({ ...buildDefaultBindingRulesOverride(), ...(rulesOverride || {}) }),
    [rulesOverride],
  )
  const rows = formatRulesSummary(rules)

  return (
    <div
      className={`rounded-lg border border-border/60 bg-surface-1/40 ${
        compact ? 'p-3 space-y-2' : 'p-4 space-y-3'
      }`}
    >
      <div>
        <p className="text-xs font-medium text-foreground">{t('rulesTitle')}</p>
        <p className="text-2xs text-muted-foreground mt-0.5">{t('rulesDescription')}</p>
      </div>
      <ul className="text-xs space-y-1.5">
        {rows.map((row) => (
          <li key={row.label} className="flex justify-between gap-3">
            <span className="text-muted-foreground shrink-0">{row.label}</span>
            <span className="text-foreground text-right">{row.value}</span>
          </li>
        ))}
      </ul>
      <p className="text-2xs text-muted-foreground/80">{t('rulesDefaultNote')}</p>
    </div>
  )
}
