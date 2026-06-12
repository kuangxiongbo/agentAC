'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Loader } from '@/components/ui/loader'
import { buildDefaultGlobalRules } from '@/lib/human-watch-defaults'
import { HumanWatchRulesDetailModal } from '@/components/settings/human-watch-rules-detail-modal'

/** 设置 · 通用：值守全局规则开关 + 弹窗详细配置。 */
export function HumanWatchGlobalRulesSection() {
  const t = useTranslations('settings')
  const [loading, setLoading] = useState(true)
  const [toggleBusy, setToggleBusy] = useState(false)
  const [enabled, setEnabled] = useState(true)
  const [rules, setRules] = useState<Record<string, unknown>>(() => ({ ...buildDefaultGlobalRules() }))
  const [error, setError] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/human-watch/rules')
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || t('humanWatchGlobalRulesLoadFailed'))
      const merged = { ...buildDefaultGlobalRules(), ...(data.rules || {}) }
      setRules(merged)
      setEnabled(merged.enabled !== false)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('humanWatchGlobalRulesLoadFailed'))
      setRules({ ...buildDefaultGlobalRules() })
      setEnabled(true)
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  const patchRules = async (patch: Record<string, unknown>) => {
    const payload = { ...rules, ...patch }
    const res = await fetch('/api/human-watch/rules', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules: payload }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || t('humanWatchGlobalRulesSaveFailed'))
    const merged = { ...buildDefaultGlobalRules(), ...(data.rules || payload) }
    setRules(merged)
    setEnabled(merged.enabled !== false)
    return merged
  }

  const onToggle = async (next: boolean) => {
    setToggleBusy(true)
    setError(null)
    const prev = enabled
    setEnabled(next)
    try {
      await patchRules({ enabled: next })
    } catch (err: unknown) {
      setEnabled(prev)
      setError(err instanceof Error ? err.message : t('humanWatchGlobalRulesSaveFailed'))
    } finally {
      setToggleBusy(false)
    }
  }

  if (loading) {
    return <Loader variant="inline" label={t('humanWatchGlobalRulesLoading')} />
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 p-3 bg-surface-1/50 border border-border/30 rounded-lg">
        <div className="flex-1 min-w-[12rem]">
          <p className="text-xs font-medium text-foreground">{t('humanWatchGlobalRulesTitle')}</p>
          <p className="text-2xs text-muted-foreground mt-0.5">{t('humanWatchGlobalRulesShortHint')}</p>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
          <input
            type="checkbox"
            checked={enabled}
            disabled={toggleBusy}
            onChange={(e) => void onToggle(e.target.checked)}
          />
          {t('humanWatchGlobalRulesEnable')}
        </label>
        <Button variant="outline" size="sm" className="text-xs shrink-0" onClick={() => setModalOpen(true)}>
          {t('humanWatchConfigureRules')}
        </Button>
      </div>
      {error ? <p className="text-xs text-rose-400 px-1">{error}</p> : null}
      <HumanWatchRulesDetailModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSaved={load}
      />
    </>
  )
}
