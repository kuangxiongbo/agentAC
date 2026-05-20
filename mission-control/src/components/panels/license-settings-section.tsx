'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Loader } from '@/components/ui/loader'
import { useAgentCenterStore } from '@/store'
import {
  CLIENT_LICENSE_ENTITLEMENT_META,
  CLIENT_LICENSE_SCHEMA,
} from '@/lib/license-schema-client'

type LicenseStatus = {
  mode: string
  licensed: boolean
  allowed: boolean
  reason?: string
  entitlements?: Record<string, unknown>
  expiresAt?: string | null
  requiresSubscription?: boolean
  subscriptionsUrl?: string
}

type LicenseConfig = {
  licenseCenterUrl: string | null
  appId?: string
  oidcClientId?: string | null
  stage?: string | null
}


function formatEntitlement(value: unknown): string {
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (value == null) return '—'
  return String(value)
}

export function LicenseSettingsSection() {
  const t = useTranslations('settings.license')
  const { currentUser } = useAgentCenterStore()
  const isAdmin = currentUser?.role === 'admin'

  const [status, setStatus] = useState<LicenseStatus | null>(null)
  const [config, setConfig] = useState<LicenseConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [configEditing, setConfigEditing] = useState(false)
  const [urlDraft, setUrlDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importErr, setImportErr] = useState('')
  const [importOk, setImportOk] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const [stRes, cfRes] = await Promise.all([
        fetch('/api/license/status', { credentials: 'include' }),
        fetch('/api/license/config', { credentials: 'include' }),
      ])
      if (stRes.ok) setStatus((await stRes.json()) as LicenseStatus)
      if (cfRes.ok) {
        const cf = (await cfRes.json()) as LicenseConfig
        setConfig(cf)
        setUrlDraft(cf.licenseCenterUrl || '')
      }
    } catch {
      setStatus({ mode: 'default', licensed: false, allowed: false, reason: 'error' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  const handleSaveConfig = async () => {
    setSaving(true)
    try {
      const r = await fetch('/api/license/config', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ licenseCenterUrl: urlDraft.trim() }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error((j as { error?: string }).error || t('saveFailed'))
      setConfigEditing(false)
      await loadAll()
    } catch (e) {
      alert(e instanceof Error ? e.message : t('saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const handleImport = async (file: File) => {
    setImportErr('')
    setImportOk(false)
    setImporting(true)
    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as unknown
      const r = await fetch('/api/license/import', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ licContent: parsed }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error((j as { error?: string }).error || t('importFailed'))
      setImportOk(true)
      await loadAll()
    } catch (e) {
      setImportErr(e instanceof Error ? e.message : t('importFailed'))
    } finally {
      setImporting(false)
    }
  }

  const downloadSchema = () => {
    window.location.href = '/api/license/schema-template'
  }

  if (loading) {
    return (
      <div className="bg-card border border-border rounded-lg p-4">
        <Loader variant="inline" label={t('loading')} />
      </div>
    )
  }

  const licensed = Boolean(status?.licensed && status?.allowed)
  const statusTone = licensed ? 'text-green-400' : status?.reason === 'expired' ? 'text-amber-400' : 'text-red-400'
  const subsUrl = status?.subscriptionsUrl || 'https://user.1sheng.work/subscriptions'

  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-4">
      <div>
        <h3 className="text-sm font-medium text-foreground">{t('title')}</h3>
        <p className="text-xs text-muted-foreground mt-0.5">{t('description')}</p>
      </div>

      <div className="rounded-lg border border-border/60 bg-surface-1/40 p-3 space-y-2 text-xs">
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">{t('statusLabel')}</span>
          <span className={`font-medium ${statusTone}`}>
            {licensed ? t('statusLicensed') : status?.reason === 'expired' ? t('statusExpired') : t('statusInactive')}
          </span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">{t('sourceLabel')}</span>
          <span className="font-mono">{status?.mode || '—'}</span>
        </div>
        {status?.expiresAt && (
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">{t('expiresLabel')}</span>
            <span>{new Date(status.expiresAt).toLocaleString()}</span>
          </div>
        )}
        <div className="pt-2 border-t border-border/40">
          <p className="text-muted-foreground mb-1.5">{t('entitlementsTitle')}</p>
          <ul className="space-y-1">
            {CLIENT_LICENSE_ENTITLEMENT_META.map((meta) => (
              <li key={meta.key} className="flex justify-between gap-2">
                <span>{meta.label}</span>
                <span>{formatEntitlement(status?.entitlements?.[meta.key])}</span>
              </li>
            ))}
          </ul>
        </div>
        {!licensed && (
          <a
            href={subsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block mt-2 text-primary hover:underline"
          >
            {t('goSubscribe')}
          </a>
        )}
      </div>

      {isAdmin && (
        <>
          <div className="space-y-2">
            <p className="text-xs font-medium text-foreground">{t('centerUrlTitle')}</p>
            {configEditing ? (
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  type="url"
                  className="flex-1 bg-background border border-border rounded px-3 py-2 text-sm"
                  value={urlDraft}
                  onChange={(e) => setUrlDraft(e.target.value)}
                  placeholder="https://user.1sheng.work"
                />
                <div className="flex gap-2">
                  <Button size="sm" disabled={saving} onClick={() => void handleSaveConfig()}>
                    {saving ? t('saving') : t('save')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setConfigEditing(false)
                      setUrlDraft(config?.licenseCenterUrl || '')
                    }}
                  >
                    {t('cancel')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <code className="text-xs font-mono text-muted-foreground break-all">
                  {config?.licenseCenterUrl || t('centerUrlUnset')}
                </code>
                <Button size="xs" variant="outline" onClick={() => setConfigEditing(true)}>
                  {t('edit')}
                </Button>
              </div>
            )}
          </div>

          <div className="space-y-2 pt-2 border-t border-border/40">
            <p className="text-xs font-medium text-foreground">{t('offlineImportTitle')}</p>
            <p className="text-2xs text-muted-foreground">{t('offlineImportHint')}</p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.lic,application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void handleImport(f)
                e.target.value = ''
              }}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={importing}
                onClick={() => fileInputRef.current?.click()}
              >
                {importing ? t('importing') : t('importLic')}
              </Button>
              <Button size="sm" variant="ghost" className="text-2xs opacity-70" onClick={downloadSchema}>
                {t('downloadSchema')}
              </Button>
            </div>
            {importOk && <p className="text-xs text-green-400">{t('importSuccess')}</p>}
            {importErr && <p className="text-xs text-destructive">{importErr}</p>}
          </div>

          <p className="text-2xs text-muted-foreground/60">
            {t('schemaHint', {
              appId: CLIENT_LICENSE_SCHEMA.appId,
              requires: CLIENT_LICENSE_SCHEMA.requiresSubscription ? t('requiresSub') : t('openUse'),
            })}
          </p>
        </>
      )}

      {!isAdmin && (
        <p className="text-2xs text-muted-foreground">{t('adminOnlyHint')}</p>
      )}
    </div>
  )
}
