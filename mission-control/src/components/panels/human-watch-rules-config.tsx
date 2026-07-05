'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Loader } from '@/components/ui/loader'
import { buildDefaultGlobalRules } from '@/lib/human-watch-defaults'

type RulesOverride = Record<string, unknown>
type StuckSignal = 'pending_tool' | 'confirmation_text' | 'awaiting_user_response'

const DEFAULT_STUCK: StuckSignal[] = ['pending_tool', 'confirmation_text', 'awaiting_user_response']

function normalizeStuckSignals(raw: unknown): StuckSignal[] {
  if (!Array.isArray(raw)) return [...DEFAULT_STUCK]
  const allowed = new Set<StuckSignal>(['pending_tool', 'confirmation_text', 'awaiting_user_response'])
  const picked = raw.filter((v): v is StuckSignal => allowed.has(v as StuckSignal))
  return picked.length > 0 ? picked : [...DEFAULT_STUCK]
}

function patternsToText(raw: unknown): string {
  if (!Array.isArray(raw)) return ''
  return (raw as string[]).map((p) => String(p).trim()).filter(Boolean).join('\n')
}

function textToPatterns(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.length > 0 ? lines : (buildDefaultGlobalRules().confirmation_patterns as string[])
}

function buildSummaryRows(
  rules: RulesOverride,
  t: (key: string, values?: Record<string, string | number | Date>) => string,
) {
  const stuck: string[] = []
  const signals = normalizeStuckSignals(rules.stuck_signals)
  if (signals.includes('pending_tool')) stuck.push(t('ruleSignalPendingTool'))
  if (signals.includes('confirmation_text')) stuck.push(t('ruleSignalConfirmation'))
  if (signals.includes('awaiting_user_response')) stuck.push(t('ruleSignalAwaitingUserResponse'))
  const patterns = Array.isArray(rules.confirmation_patterns)
    ? (rules.confirmation_patterns as string[]).length
    : 0
  return [
    {
      label: t('ruleSummaryRulesEnabled'),
      value: rules.enabled === false ? t('ruleOff') : t('ruleOn'),
    },
    { label: t('ruleIdleSeconds'), value: `${rules.idle_timeout_seconds ?? 90}s` },
    {
      label: t('ruleToolExcludeSeconds'),
      value: `${rules.exclude_if_tool_active_within_seconds ?? 120}s`,
    },
    { label: t('ruleStuckSignals'), value: stuck.length ? stuck.join(', ') : '—' },
    { label: t('ruleConfirmationPatterns'), value: t('rulePatternCount', { count: patterns }) },
    {
      label: t('ruleRequireCombination'),
      value: rules.require_combination === false ? t('ruleComboAny') : t('ruleComboAll'),
    },
    { label: t('ruleGraceSeconds'), value: `${rules.grace_after_prompt_seconds ?? 30}s` },
    { label: t('ruleMaxPerHour'), value: String(rules.max_interventions_per_hour ?? 6) },
  ]
}

/** 租户全局值守判断规则（L1–L3 + 节流），所有 Worker 绑定共用。 */
export function HumanWatchRulesConfig({
  compact = false,
  editable = true,
  variant = 'full',
  onSaved,
}: {
  compact?: boolean
  /** @deprecated 使用 variant */
  editable?: boolean
  /** full=内联完整；detail=弹窗内表单（无开关）；summary=只读摘要 */
  variant?: 'full' | 'detail' | 'summary'
  onSaved?: () => void | Promise<void>
}) {
  const resolvedVariant = !editable ? 'summary' : variant
  const t = useTranslations('humanWatch')
  const [loading, setLoading] = useState(true)
  const [rules, setRules] = useState<RulesOverride>(() => ({ ...buildDefaultGlobalRules() }))
  const [rulesEngineEnabled, setRulesEngineEnabled] = useState(true)
  const [idleSec, setIdleSec] = useState('90')
  const [toolExcludeSec, setToolExcludeSec] = useState('120')
  const [signalPendingTool, setSignalPendingTool] = useState(true)
  const [signalConfirmation, setSignalConfirmation] = useState(true)
  const [signalAwaitingUserResponse, setSignalAwaitingUserResponse] = useState(true)
  const [requireCombination, setRequireCombination] = useState(true)
  const [patternsText, setPatternsText] = useState('')
  const [graceSec, setGraceSec] = useState('30')
  const [maxHour, setMaxHour] = useState('6')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const applyRulesToForm = useCallback((merged: RulesOverride) => {
    setRules(merged)
    setRulesEngineEnabled(merged.enabled !== false)
    setIdleSec(String(merged.idle_timeout_seconds ?? 90))
    setToolExcludeSec(String(merged.exclude_if_tool_active_within_seconds ?? 120))
    const stuck = normalizeStuckSignals(merged.stuck_signals)
    setSignalPendingTool(stuck.includes('pending_tool'))
    setSignalConfirmation(stuck.includes('confirmation_text'))
    setSignalAwaitingUserResponse(stuck.includes('awaiting_user_response'))
    setRequireCombination(merged.require_combination !== false)
    setPatternsText(patternsToText(merged.confirmation_patterns))
    setGraceSec(String(merged.grace_after_prompt_seconds ?? 30))
    setMaxHour(String(merged.max_interventions_per_hour ?? 6))
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/human-watch/rules')
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || t('loadGlobalRulesFailed'))
      const merged = { ...buildDefaultGlobalRules(), ...(data.rules || {}) }
      applyRulesToForm(merged)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('loadGlobalRulesFailed'))
      applyRulesToForm({ ...buildDefaultGlobalRules() })
    } finally {
      setLoading(false)
    }
  }, [applyRulesToForm, t])

  useEffect(() => {
    void load()
  }, [load])

  const summaryRows = useMemo(() => buildSummaryRows(rules, t), [rules, t])

  const saveRules = async () => {
    setBusy(true)
    setError(null)
    try {
      const stuck_signals: StuckSignal[] = []
      if (signalPendingTool) stuck_signals.push('pending_tool')
      if (signalConfirmation) stuck_signals.push('confirmation_text')
      if (signalAwaitingUserResponse) stuck_signals.push('awaiting_user_response')
      if (stuck_signals.length === 0) {
        setError(t('ruleStuckSignalsRequired'))
        return
      }

      const payload = {
        enabled: rulesEngineEnabled,
        idle_timeout_seconds: Math.max(30, Number(idleSec) || 90),
        exclude_if_tool_active_within_seconds: Math.max(0, Number(toolExcludeSec) || 120),
        stuck_signals,
        confirmation_patterns: textToPatterns(patternsText),
        require_combination: requireCombination,
        grace_after_prompt_seconds: Math.max(0, Number(graceSec) || 30),
        max_interventions_per_hour: Math.max(1, Number(maxHour) || 6),
      }

      const res = await fetch('/api/human-watch/rules', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: payload }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || t('saveRulesFailed'))
      applyRulesToForm({ ...buildDefaultGlobalRules(), ...(data.rules || payload) })
      await onSaved?.()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('saveRulesFailed'))
    } finally {
      setBusy(false)
    }
  }

  const inputClass =
    'mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm'
  const labelClass = 'block text-muted-foreground'

  if (loading) {
    return <Loader variant="inline" label={t('loadingGlobalRules')} />
  }

  const showHeader = resolvedVariant === 'full'
  const showFooterNote = resolvedVariant === 'full'
  const isDetailForm = resolvedVariant === 'detail'
  const isSummary = resolvedVariant === 'summary'

  return (
    <div
      className={
        isDetailForm
          ? 'space-y-3 text-xs'
          : `rounded-lg border border-border/60 bg-surface-1/40 ${
              compact ? 'p-3 space-y-2' : 'p-4 space-y-3'
            }`
      }
    >
      {showHeader ? (
        <div>
          <p className="text-xs font-medium text-foreground">{t('globalRulesTitle')}</p>
          <p className="text-2xs text-muted-foreground mt-0.5">{t('globalRulesDescription')}</p>
        </div>
      ) : null}

      {!isSummary ? (
        <div className="space-y-3 text-xs">
          {resolvedVariant === 'full' ? (
            <label className={`${labelClass} flex items-center gap-2`}>
              <input
                type="checkbox"
                checked={rulesEngineEnabled}
                onChange={(e) => setRulesEngineEnabled(e.target.checked)}
              />
              {t('ruleSummaryRulesEnabled')}
            </label>
          ) : null}

          <p className="text-2xs font-medium text-foreground/90">{t('ruleSectionTrigger')}</p>

          <label className={labelClass}>
            {t('ruleIdleSeconds')}
            <input
              type="number"
              min={30}
              className={inputClass}
              value={idleSec}
              onChange={(e) => setIdleSec(e.target.value)}
            />
          </label>

          <label className={labelClass}>
            {t('ruleToolExcludeSeconds')}
            <input
              type="number"
              min={0}
              className={inputClass}
              value={toolExcludeSec}
              onChange={(e) => setToolExcludeSec(e.target.value)}
            />
            <span className="text-2xs text-muted-foreground/80 mt-0.5 block">{t('ruleToolExcludeHint')}</span>
          </label>

          <fieldset className="space-y-1.5">
            <legend className="text-muted-foreground">{t('ruleStuckSignals')}</legend>
            <label className="flex items-center gap-2 text-foreground">
              <input
                type="checkbox"
                checked={signalPendingTool}
                onChange={(e) => setSignalPendingTool(e.target.checked)}
              />
              {t('ruleSignalPendingTool')}
            </label>
            <label className="flex items-center gap-2 text-foreground">
              <input
                type="checkbox"
                checked={signalConfirmation}
                onChange={(e) => setSignalConfirmation(e.target.checked)}
              />
              {t('ruleSignalConfirmation')}
            </label>
            <label className="flex items-center gap-2 text-foreground">
              <input
                type="checkbox"
                checked={signalAwaitingUserResponse}
                onChange={(e) => setSignalAwaitingUserResponse(e.target.checked)}
              />
              {t('ruleSignalAwaitingUserResponse')}
            </label>
          </fieldset>

          <label className={labelClass}>
            {t('ruleConfirmationPatterns')}
            <textarea
              rows={5}
              className={`${inputClass} font-mono text-2xs`}
              value={patternsText}
              onChange={(e) => setPatternsText(e.target.value)}
              placeholder={t('ruleConfirmationPatternsPlaceholder')}
            />
            <span className="text-2xs text-muted-foreground/80 mt-0.5 block">{t('ruleConfirmationPatternsHint')}</span>
          </label>

          <label className={labelClass}>
            {t('ruleRequireCombination')}
            <select
              className={inputClass}
              value={requireCombination ? 'all' : 'any'}
              onChange={(e) => setRequireCombination(e.target.value === 'all')}
            >
              <option value="all">{t('ruleComboAll')}</option>
              <option value="any">{t('ruleComboAny')}</option>
            </select>
          </label>

          <p className="text-2xs font-medium text-foreground/90">{t('ruleSectionThrottle')}</p>

          <label className={labelClass}>
            {t('ruleGraceSeconds')}
            <input
              type="number"
              min={0}
              className={inputClass}
              value={graceSec}
              onChange={(e) => setGraceSec(e.target.value)}
            />
          </label>

          <label className={labelClass}>
            {t('ruleMaxPerHour')}
            <input
              type="number"
              min={1}
              className={inputClass}
              value={maxHour}
              onChange={(e) => setMaxHour(e.target.value)}
            />
          </label>

          <p className="text-2xs text-muted-foreground/80">{t('ruleLlmReplyHint')}</p>

          {error ? <p className="text-rose-400">{error}</p> : null}
          <Button size="sm" disabled={busy} onClick={() => void saveRules()}>
            {busy ? t('savingRules') : isDetailForm ? t('saveRules') : t('saveGlobalRules')}
          </Button>
        </div>
      ) : (
        <ul className="text-xs space-y-1.5">
          {summaryRows.map((row) => (
            <li key={row.label} className="flex justify-between gap-3">
              <span className="text-muted-foreground shrink-0">{row.label}</span>
              <span className="text-foreground text-right">{row.value}</span>
            </li>
          ))}
        </ul>
      )}

      {showFooterNote ? (
        <p className="text-2xs text-muted-foreground/80">{t('rulesDefaultNote')}</p>
      ) : null}
    </div>
  )
}
