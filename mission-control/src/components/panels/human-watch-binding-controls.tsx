'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import type { HumanWatchBindingMode } from '@/lib/human-watch-types'

export function HumanWatchBindingControls({
  bindingId,
  enabled,
  mode,
  rulesOverride,
  onSaved,
}: {
  bindingId: number
  enabled: boolean
  mode: HumanWatchBindingMode
  rulesOverride?: Record<string, unknown> | null
  onSaved?: () => void | Promise<void>
}) {
  const t = useTranslations('humanWatch')
  const [bindingEnabled, setBindingEnabled] = useState(enabled)
  const [bindingMode, setBindingMode] = useState<HumanWatchBindingMode>(mode)
  const [autoStopEnabled, setAutoStopEnabled] = useState(false)
  const [maxSuccess, setMaxSuccess] = useState('20')
  const [maxMinutes, setMaxMinutes] = useState('30')
  const [maxRateLimited, setMaxRateLimited] = useState('3')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setBindingEnabled(enabled)
    setBindingMode(mode)
    const autoStop =
      rulesOverride?.auto_stop && typeof rulesOverride.auto_stop === 'object'
        ? (rulesOverride.auto_stop as Record<string, unknown>)
        : {}
    setAutoStopEnabled(autoStop.enabled === true)
    setMaxSuccess(String(autoStop.max_successful_interventions ?? '20'))
    setMaxMinutes(String(Math.ceil(Number(autoStop.max_runtime_seconds ?? 1800) / 60)))
    setMaxRateLimited(String(autoStop.max_rate_limited_skips ?? '3'))
  }, [enabled, mode, rulesOverride])

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const nextRulesOverride = {
        ...(rulesOverride || {}),
        auto_stop: {
          enabled: autoStopEnabled,
          max_successful_interventions: Math.max(1, Number(maxSuccess) || 20),
          max_runtime_seconds: Math.max(60, (Number(maxMinutes) || 30) * 60),
          max_rate_limited_skips: Math.max(1, Number(maxRateLimited) || 3),
        },
      }
      const res = await fetch(`/api/human-watch/bindings/${bindingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: bindingEnabled,
          mode: bindingMode,
          rules_override: nextRulesOverride,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || t('saveBindingSettingsFailed'))
      await onSaved?.()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('saveBindingSettingsFailed'))
    } finally {
      setBusy(false)
    }
  }

  const inputClass =
    'mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm'

  return (
    <div className="rounded-lg border border-border/60 bg-surface-1/40 p-3 space-y-2 text-xs">
      <p className="text-xs font-medium text-foreground">{t('bindingSettingsTitle')}</p>
      <label className="flex items-center gap-2 text-muted-foreground">
        <input
          type="checkbox"
          checked={bindingEnabled}
          onChange={(e) => setBindingEnabled(e.target.checked)}
        />
        {t('ruleBindingEnabled')}
      </label>
      <label className="block text-muted-foreground">
        {t('ruleBindingMode')}
        <select
          className={inputClass}
          value={bindingMode}
          onChange={(e) => setBindingMode(e.target.value as HumanWatchBindingMode)}
        >
          <option value="auto_send">{t('ruleModeAuto')}</option>
          <option value="suggest_only">{t('ruleModeSuggest')}</option>
        </select>
      </label>
      <div className="rounded-md border border-border/60 bg-background/40 p-2 space-y-2">
        <label className="flex items-center gap-2 text-muted-foreground">
          <input
            type="checkbox"
            checked={autoStopEnabled}
            onChange={(e) => setAutoStopEnabled(e.target.checked)}
          />
          自动停止
        </label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <label className="block text-muted-foreground">
            成功次数
            <input
              className={inputClass}
              type="number"
              min={1}
              value={maxSuccess}
              onChange={(e) => setMaxSuccess(e.target.value)}
            />
          </label>
          <label className="block text-muted-foreground">
            运行分钟
            <input
              className={inputClass}
              type="number"
              min={1}
              value={maxMinutes}
              onChange={(e) => setMaxMinutes(e.target.value)}
            />
          </label>
          <label className="block text-muted-foreground">
            限流次数
            <input
              className={inputClass}
              type="number"
              min={1}
              value={maxRateLimited}
              onChange={(e) => setMaxRateLimited(e.target.value)}
            />
          </label>
        </div>
      </div>
      {error ? <p className="text-rose-400">{error}</p> : null}
      <Button size="sm" disabled={busy} onClick={() => void save()}>
        {busy ? t('savingBindingSettings') : t('saveBindingSettings')}
      </Button>
    </div>
  )
}
