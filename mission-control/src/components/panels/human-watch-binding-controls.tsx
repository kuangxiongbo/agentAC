'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import type { HumanWatchBindingMode } from '@/lib/human-watch-types'

export function HumanWatchBindingControls({
  bindingId,
  enabled,
  mode,
  onSaved,
}: {
  bindingId: number
  enabled: boolean
  mode: HumanWatchBindingMode
  onSaved?: () => void | Promise<void>
}) {
  const t = useTranslations('humanWatch')
  const [bindingEnabled, setBindingEnabled] = useState(enabled)
  const [bindingMode, setBindingMode] = useState<HumanWatchBindingMode>(mode)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setBindingEnabled(enabled)
    setBindingMode(mode)
  }, [enabled, mode])

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/human-watch/bindings/${bindingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: bindingEnabled, mode: bindingMode }),
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
      {error ? <p className="text-rose-400">{error}</p> : null}
      <Button size="sm" disabled={busy} onClick={() => void save()}>
        {busy ? t('savingBindingSettings') : t('saveBindingSettings')}
      </Button>
    </div>
  )
}
