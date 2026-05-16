'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import Image from 'next/image'
import { sanitizeOidcReturnPath } from '@/lib/zitadel-sso-client'

function sanitizeHandoffNext(raw: string | null): string {
  const p = sanitizeOidcReturnPath(raw)
  if (p === '/login' || p.startsWith('/login/')) return '/'
  if (p.startsWith('/auth/enter')) return '/'
  return p
}

function AuthEnterInner() {
  const t = useTranslations('auth')
  const searchParams = useSearchParams()
  const [orgName, setOrgName] = useState<string | null>(null)

  useEffect(() => {
    const next = sanitizeHandoffNext(searchParams.get('next'))
    let cancelled = false
    let attempts = 0
    const maxAttempts = 16
    const delayMs = 120

    const tick = async () => {
      if (cancelled) return
      try {
        const res = await fetch('/api/auth/me', { credentials: 'include', cache: 'no-store' })
        if (res.ok) {
          const data = (await res.json().catch(() => null)) as { user?: { organization?: { display_name?: string } | null } } | null
          const name = data?.user?.organization?.display_name?.trim()
          if (name) setOrgName(name)
          await new Promise((r) => setTimeout(r, 80))
          if (!cancelled) {
            window.location.replace(next)
          }
          return
        }
      } catch {
        // retry
      }
      attempts += 1
      if (attempts >= maxAttempts) {
        window.location.replace(
          `/login?login_error=session_pending&next=${encodeURIComponent(next)}`
        )
        return
      }
      setTimeout(tick, delayMs)
    }

    void tick()
    return () => {
      cancelled = true
    }
  }, [searchParams])

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background p-6 void-bg">
      <div className="w-16 h-16 rounded-2xl overflow-hidden bg-card border border-border flex items-center justify-center mb-6 shadow-xl">
        <Image src="/brand/app-logo.png" alt="" width={56} height={56} className="object-contain p-2" priority />
      </div>
      <div className="w-9 h-9 border-2 border-muted border-t-primary rounded-full animate-spin mb-5" aria-hidden />
      <p className="text-base font-medium text-foreground text-center">{t('ssoHandoffTitle')}</p>
      {orgName ? (
        <p className="mt-3 text-sm text-muted-foreground text-center max-w-md">{t('ssoHandoffOrganization', { name: orgName })}</p>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground text-center max-w-md opacity-80">{t('ssoHandoffSubtitle')}</p>
      )}
    </div>
  )
}

export function AuthEnterClient() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex flex-col items-center justify-center bg-background">
          <div className="w-9 h-9 border-2 border-muted border-t-primary rounded-full animate-spin" />
        </div>
      }
    >
      <AuthEnterInner />
    </Suspense>
  )
}
