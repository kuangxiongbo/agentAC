'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { LanguageSwitcherSelect } from '@/components/ui/language-switcher'
import { DownloadIcon } from '@/components/edge/edge-download-link'

type DownloadInfo = {
  center_url: string
  enterprise_name: string
  enroll_token_configured: boolean
  enroll_token: string
  enroll_token_source: 'env' | 'api_key' | 'bridge' | 'multi' | 'none'
  enroll_token_options: string[]
  tray_download_url: string | null
  tray_version: string
  platform: string
}

function CopyField({
  label,
  value,
  copyLabel,
  copiedLabel,
  mono = true,
}: {
  label: string
  value: string
  copyLabel: string
  copiedLabel: string
  mono?: boolean
}) {
  const [copied, setCopied] = useState(false)

  const copy = useCallback(async () => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // ignore
    }
  }, [value])

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <Button type="button" variant="ghost" size="xs" onClick={() => void copy()} disabled={!value}>
          {copied ? copiedLabel : copyLabel}
        </Button>
      </div>
      <div
        className={`rounded-md border border-border/60 bg-background/60 px-3 py-2 text-sm break-all select-all ${
          mono ? 'font-mono text-xs' : ''
        }`}
      >
        {value || '—'}
      </div>
    </div>
  )
}

function InstallStep({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="text-sm text-muted-foreground space-y-2">
      <span>
        <span className="font-medium text-foreground/90">{n}.</span> {children}
      </span>
    </li>
  )
}

export default function EdgeDownloadPage() {
  const t = useTranslations('edgeDownload')
  const tc = useTranslations('common')
  const [info, setInfo] = useState<DownloadInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadInfo = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/edge/download-info', { cache: 'no-store' })
      if (res.status === 401) {
        window.location.href = `/login?returnTo=${encodeURIComponent('/edge/download')}`
        return
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(typeof data.error === 'string' ? data.error : t('loadFailed'))
      }
      setInfo(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : t('loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void loadInfo()
  }, [loadInfo])

  const tokenHint = (() => {
    if (!info) return ''
    if (!info.enroll_token_configured) return t('tokenNotConfiguredHint')
    if (info.enroll_token_source === 'api_key') return t('tokenFromApiKey')
    if (info.enroll_token_source === 'bridge') return t('tokenFromBridge')
    if (info.enroll_token_source === 'multi') return t('tokenMultiHint')
    return t('tokenFromEnv')
  })()

  const cmdClearDmg = 'xattr -cr ~/Downloads/e-agent-edge-*.dmg'
  const cmdClearApp = 'xattr -cr "/Applications/E-Agent Edge.app"'
  const cmdFallback = 'codesign --force --deep --sign - "/Applications/E-Agent Edge.app"\nopen -a "E-Agent Edge"'

  return (
    <div className="h-full overflow-y-auto bg-background text-foreground flex flex-col">
      <header className="sticky top-0 z-10 flex shrink-0 items-center justify-between border-b border-border bg-background/95 px-4 py-3 backdrop-blur-sm">
        <Link href="/" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <span aria-hidden>←</span>
          {t('backToDashboard')}
        </Link>
        <LanguageSwitcherSelect />
      </header>

      <main className="flex-1 p-6 pb-12">
        <div className="mx-auto w-full max-w-xl rounded-xl border border-border bg-card/80 p-6 shadow-xl backdrop-blur-sm md:p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 rounded-lg overflow-hidden border border-border/60 bg-background flex items-center justify-center shrink-0">
              <Image src="/brand/app-logo.png" alt="" width={48} height={48} className="w-full h-full object-contain" />
            </div>
            <div>
              <h1 className="text-lg font-semibold">{t('title')}</h1>
              <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
            </div>
          </div>

          {loading && (
            <div className="py-8 text-center text-sm text-muted-foreground">{tc('loading')}</div>
          )}

          {!loading && error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive mb-4">
              {error}
            </div>
          )}

          {!loading && info && (
            <div className="space-y-5">
              <div className="rounded-lg border border-border/60 bg-secondary/20 p-4 space-y-4">
                {info.enterprise_name && (
                  <div className="flex justify-between gap-3 text-sm">
                    <span className="text-muted-foreground">{t('enterprise')}</span>
                    <span className="text-foreground/90">{info.enterprise_name}</span>
                  </div>
                )}
                <CopyField
                  label={t('centerUrl')}
                  value={info.center_url}
                  copyLabel={t('copy')}
                  copiedLabel={t('copied')}
                />
                <CopyField
                  label={t('enrollToken')}
                  value={info.enroll_token_configured ? info.enroll_token : ''}
                  copyLabel={t('copy')}
                  copiedLabel={t('copied')}
                />
                {info.enroll_token_source === 'multi' && info.enroll_token_options.length > 1 && (
                  <div className="space-y-2 pt-1">
                    <p className="text-xs text-muted-foreground">{t('tokenMultiList')}</p>
                    {info.enroll_token_options.map((token) => (
                      <CopyField
                        key={token}
                        label={t('enrollTokenOption')}
                        value={token}
                        copyLabel={t('copy')}
                        copiedLabel={t('copied')}
                      />
                    ))}
                  </div>
                )}
                {tokenHint && (
                  <p className={`text-xs leading-relaxed ${info.enroll_token_configured ? 'text-muted-foreground' : 'text-amber-400/90'}`}>
                    {tokenHint}
                  </p>
                )}
              </div>

              {info.tray_download_url ? (
                <Button asChild className="w-full">
                  <a href={info.tray_download_url} download>
                    <DownloadIcon className="w-4 h-4 mr-2" />
                    {t('downloadDmg', { version: info.tray_version })}
                  </a>
                </Button>
              ) : (
                <div className="rounded-lg border border-border/60 bg-secondary/10 px-3 py-2 text-xs text-muted-foreground">
                  {t('dmgNotAvailableHint')}
                </div>
              )}

              <div className="space-y-3">
                <h2 className="text-sm font-medium">{t('stepsTitle')}</h2>
                <div className="space-y-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                  <p className="font-medium text-amber-200/90">{t('macInstallNoteTitle')}</p>
                  <p>{t('macInstallNote')}</p>
                  <p>{t('macInstallNoteDmg')}</p>
                </div>
                <ol className="list-none space-y-4 pl-0">
                  <InstallStep n={1}>{t('step1Download')}</InstallStep>
                  <InstallStep n={2}>{t('step2Eject')}</InstallStep>
                  <InstallStep n={3}>
                    <span>{t('step3ClearQuarantineDmg')}</span>
                    <p className="mt-1 text-xs text-muted-foreground/90">{t('step3DmgFilenameHint')}</p>
                    <div className="mt-2">
                      <CopyField
                        label={t('cmdClearDmg')}
                        value={cmdClearDmg}
                        copyLabel={t('copy')}
                        copiedLabel={t('copied')}
                      />
                    </div>
                  </InstallStep>
                  <InstallStep n={4}>
                    <span>{t('step4OpenDmg')}</span>
                    <p className="mt-1 text-xs text-amber-200/80">{t('step4DoNotRunFromDmg')}</p>
                  </InstallStep>
                  <InstallStep n={5}>
                    <span>{t('step5EjectAfterCopy')}</span>
                  </InstallStep>
                  <InstallStep n={6}>
                    <span>{t('step5ClearQuarantineApp')}</span>
                    <div className="mt-2">
                      <CopyField
                        label={t('cmdClearApp')}
                        value={cmdClearApp}
                        copyLabel={t('copy')}
                        copiedLabel={t('copied')}
                      />
                    </div>
                  </InstallStep>
                  <InstallStep n={7}>
                    <span>{t('step6Launch')}</span>
                    <p className="mt-1 text-xs text-muted-foreground/90">{t('step6OpenAnyway')}</p>
                    <div className="mt-2 space-y-1.5">
                      <p className="text-xs text-muted-foreground">{t('cmdFallbackTitle')}</p>
                      <CopyField
                        label={t('cmdFallback')}
                        value={cmdFallback}
                        copyLabel={t('copy')}
                        copiedLabel={t('copied')}
                      />
                    </div>
                  </InstallStep>
                  <InstallStep n={8}>{t('step7Paste')}</InstallStep>
                  <InstallStep n={9}>{t('step8Connect')}</InstallStep>
                </ol>
              </div>

              <p className="text-xs text-muted-foreground leading-relaxed">{t('requirements')}</p>
              <p className="text-xs text-muted-foreground/80 leading-relaxed">{t('dmgPreconfigNote')}</p>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
