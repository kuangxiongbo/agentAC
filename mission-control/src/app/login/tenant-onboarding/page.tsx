'use client'

import { FormEvent, useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { TenantOnboardingGate, type OnboardingStatus } from '@/components/auth/tenant-onboarding-gate'
import { buildZitadelStartLoginUrl } from '@/lib/zitadel-sso-client'

type PendingState = {
  proofToken: string
  email: string
  displayName: string
  returnTo: string
  zitadelSub: string
}

type JoinSuggestion = {
  tenantId: string
  tenantName: string
  slug: string
  loginRouteSegment?: string | null
  score: number
} | null

type JoinSearchResult = {
  exactMatch: boolean
  tenant?: { tenantId: string; tenantName: string; slug: string }
  suggestion?: JoinSuggestion
} | null

function decodeProofSub(token: string): string {
  try {
    const b64 = token.split('.')[0]
    if (!b64) return ''
    const json = JSON.parse(atob(b64.replace(/-/g, '+').replace(/_/g, '/'))) as { zitadelSub?: string }
    return typeof json.zitadelSub === 'string' ? json.zitadelSub : ''
  } catch {
    return ''
  }
}

export default function TenantOnboardingPage() {
  const t = useTranslations('auth.tenantOnboarding')
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<PendingState | null>(null)
  const [onboardingStatus, setOnboardingStatus] = useState<OnboardingStatus | null>(null)

  const [verifiedRegTenantName, setVerifiedRegTenantName] = useState('')
  const [verifiedRegTenantSlug, setVerifiedRegTenantSlug] = useState('')
  const [verifiedRegDisplayName, setVerifiedRegDisplayName] = useState('')
  const [verifiedRegBusy, setVerifiedRegBusy] = useState(false)
  const [verifiedRegErr, setVerifiedRegErr] = useState<string | null>(null)

  const [joinTenantHint, setJoinTenantHint] = useState('')
  const [joinDisplayName, setJoinDisplayName] = useState('')
  const [joinMessage, setJoinMessage] = useState('')
  const [joinBusy, setJoinBusy] = useState(false)
  const [joinSearchBusy, setJoinSearchBusy] = useState(false)
  const [joinErr, setJoinErr] = useState<string | null>(null)
  const [joinDelivery, setJoinDelivery] = useState<'smtp' | 'log' | null>(null)
  const [joinSuggestion, setJoinSuggestion] = useState<JoinSuggestion>(null)
  const [joinSearchResult, setJoinSearchResult] = useState<JoinSearchResult>(null)

  const resumeSso = useCallback((email: string, returnTo: string) => {
    window.location.assign(buildZitadelStartLoginUrl({ returnTo, loginHint: email }))
  }, [])

  const refreshOnboardingStatus = useCallback(async (subject: string) => {
    if (!subject) return
    const r = await fetch(`/api/auth/onboarding-status?subject=${encodeURIComponent(subject)}`, {
      credentials: 'include',
      cache: 'no-store',
    })
    if (!r.ok) return
    const d = (await r.json().catch(() => null)) as OnboardingStatus | null
    if (d) setOnboardingStatus(d)
    return d
  }, [])

  useEffect(() => {
    fetch('/api/auth/pending-onboarding', { credentials: 'include', cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (d?.pending && d.proofToken && d.email) {
          const next: PendingState = {
            proofToken: d.proofToken,
            email: d.email,
            displayName: d.displayName || d.email,
            returnTo: typeof d.returnTo === 'string' ? d.returnTo : '/',
            zitadelSub: typeof d.zitadelSub === 'string' ? d.zitadelSub : decodeProofSub(d.proofToken),
          }
          setPending(next)
          setVerifiedRegDisplayName(next.displayName)
          setJoinDisplayName(next.displayName)
          if (next.zitadelSub) void refreshOnboardingStatus(next.zitadelSub)
        } else {
          window.location.replace('/login')
        }
      })
      .catch(() => window.location.replace('/login'))
      .finally(() => setLoading(false))
  }, [refreshOnboardingStatus])

  async function handleRegisterTenantFromVerified(e: FormEvent) {
    e.preventDefault()
    if (!pending) return
    setVerifiedRegBusy(true)
    setVerifiedRegErr(null)
    const slugRaw = verifiedRegTenantSlug.trim()
    try {
      const r = await fetch('/api/auth/register-tenant-from-zitadel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proofToken: pending.proofToken,
          tenantName: verifiedRegTenantName.trim(),
          displayName: verifiedRegDisplayName.trim() || pending.displayName,
          ...(slugRaw ? { tenantSlug: slugRaw.toLowerCase() } : {}),
        }),
      })
      const d = (await r.json().catch(() => ({}))) as { error?: string }
      if (!r.ok) {
        setVerifiedRegErr(d.error || t('registerFailed'))
        return
      }
      resumeSso(pending.email, pending.returnTo)
    } catch {
      setVerifiedRegErr(t('networkError'))
    } finally {
      setVerifiedRegBusy(false)
    }
  }

  async function handleJoinExistingTenant(e: FormEvent) {
    e.preventDefault()
    if (!pending) return
    const q = joinTenantHint.trim()
    if (!q) return
    setJoinSearchBusy(true)
    setJoinErr(null)
    setJoinSearchResult(null)
    setJoinSuggestion(null)
    try {
      const r = await fetch(`/api/auth/join-tenant-search?q=${encodeURIComponent(q)}`, {
        credentials: 'include',
        cache: 'no-store',
      })
      const d = (await r.json().catch(() => ({}))) as {
        error?: string
        exactMatch?: boolean
        tenant?: { tenantId: string; tenantName: string; slug: string }
        suggestion?: JoinSuggestion
      }
      if (!r.ok) {
        setJoinErr(d.error || t('searchFailed'))
        setJoinSuggestion(d.suggestion || null)
        return
      }
      setJoinSearchResult({
        exactMatch: d.exactMatch === true,
        tenant: d.tenant,
        suggestion: d.suggestion || null,
      })
      setJoinSuggestion(d.suggestion || null)
    } catch {
      setJoinErr(t('networkError'))
    } finally {
      setJoinSearchBusy(false)
    }
  }

  async function handleApplyJoinTenant(tenantHintOverride?: string) {
    if (!pending) return
    const tenantHint = (tenantHintOverride || joinTenantHint).trim()
    if (!tenantHint) {
      setJoinErr(t('joinSelectFirst'))
      return
    }
    setJoinBusy(true)
    setJoinErr(null)
    setJoinDelivery(null)
    try {
      const r = await fetch('/api/auth/join-tenant-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proofToken: pending.proofToken,
          tenantHint,
          displayName: joinDisplayName.trim() || pending.displayName,
          message: joinMessage.trim(),
        }),
      })
      const d = (await r.json().catch(() => ({}))) as {
        error?: string
        tenantName?: string
        delivery?: 'smtp' | 'log'
        suggestion?: JoinSuggestion
      }
      if (!r.ok) {
        setJoinErr(d.error || t('joinFailed'))
        setJoinSuggestion(d.suggestion || null)
        return
      }
      setJoinDelivery(d.delivery === 'log' ? 'log' : 'smtp')
      setJoinSearchResult(null)
      setJoinSuggestion(null)
      setJoinMessage('')
      if (pending.zitadelSub) await refreshOnboardingStatus(pending.zitadelSub)
    } catch {
      setJoinErr(t('networkError'))
    } finally {
      setJoinBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#050914] p-4">
        <p className="text-sm font-bold text-white/55">{t('loading')}</p>
      </div>
    )
  }

  if (!pending) return null

  return (
    <TenantOnboardingGate
      email={pending.email}
      displayName={pending.displayName}
      onboardingStatus={onboardingStatus}
      joinTenantHint={joinTenantHint}
      setJoinTenantHint={setJoinTenantHint}
      joinDisplayName={joinDisplayName}
      setJoinDisplayName={setJoinDisplayName}
      joinMessage={joinMessage}
      setJoinMessage={setJoinMessage}
      joinBusy={joinBusy}
      joinSearchBusy={joinSearchBusy}
      joinErr={joinErr}
      joinDelivery={joinDelivery}
      joinSuggestion={joinSuggestion}
      joinSearchResult={joinSearchResult}
      verifiedRegTenantName={verifiedRegTenantName}
      setVerifiedRegTenantName={setVerifiedRegTenantName}
      verifiedRegTenantSlug={verifiedRegTenantSlug}
      setVerifiedRegTenantSlug={setVerifiedRegTenantSlug}
      verifiedRegDisplayName={verifiedRegDisplayName}
      setVerifiedRegDisplayName={setVerifiedRegDisplayName}
      verifiedRegBusy={verifiedRegBusy}
      verifiedRegErr={verifiedRegErr}
      onJoinExistingTenant={handleJoinExistingTenant}
      onApplyJoinTenant={handleApplyJoinTenant}
      onRegisterTenantFromVerified={handleRegisterTenantFromVerified}
      onRefreshOnboardingStatus={() => {
        if (pending.zitadelSub) void refreshOnboardingStatus(pending.zitadelSub)
      }}
      onResumeConsole={() => resumeSso(pending.email, pending.returnTo)}
    />
  )
}