'use client'

import { useCallback, useEffect, useRef, useState, FormEvent } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { LanguageSwitcherSelect } from '@/components/ui/language-switcher'
import { resolveOidcPostLoginReturnTo, buildZitadelStartLoginUrl } from '@/lib/zitadel-sso-client'

interface GoogleCredentialResponse {
  credential?: string
}

interface GoogleAccountsIdApi {
  initialize(config: {
    client_id: string
    callback: (response: GoogleCredentialResponse) => void
  }): void
  prompt(): void
}

interface GoogleApi {
  accounts: {
    id: GoogleAccountsIdApi
  }
}

type LoginRequestBody =
  | { username: string; password: string }
  | { credential?: string }

type LoginErrorPayload = {
  code?: string
  error?: string
  hint?: string
}

function readLoginErrorPayload(value: unknown): LoginErrorPayload {
  if (!value || typeof value !== 'object') return {}
  const record = value as Record<string, unknown>
  return {
    code: typeof record.code === 'string' ? record.code : undefined,
    error: typeof record.error === 'string' ? record.error : undefined,
    hint: typeof record.hint === 'string' ? record.hint : undefined,
  }
}

declare global {
  interface Window {
    google?: GoogleApi
  }
}

function MailIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </svg>
  )
}

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.96 10.96 0 001 12c0 1.77.42 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  )
}

export default function LoginPage() {
  const t = useTranslations('auth')
  const tc = useTranslations('common')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [needsSetup, setNeedsSetup] = useState(false)
  const [loading, setLoading] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)
  const [googleReady, setGoogleReady] = useState(false)
  const [ssoReady, setSsoReady] = useState(false)
  const [ssoInfo, setSsoInfo] = useState<{
    zitadel: boolean
    mode: 'off' | 'sso_primary' | 'sso_only'
    registerUrl?: string | null
    oidcEntryOrigin?: string | null
  } | null>(null)
  const [localBypass, setLocalBypass] = useState(false)
  const [loginHintEmail, setLoginHintEmail] = useState('')
  const [returnTo, setReturnTo] = useState('/')
  const [ssoNavigating, setSsoNavigating] = useState(false)
  const googleCallbackRef = useRef<((response: GoogleCredentialResponse) => void) | null>(null)

  const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || ''
  const zitadelEnabled = Boolean(ssoInfo?.zitadel)
  /** 无 OIDC，或应急 `?local=1`：显示本地 / Google 登录（须在已知 OIDC 配置后判断，避免 SSO 就绪前误显本地表单） */
  const showLocalLogin = ssoReady && (!zitadelEnabled || localBypass)
  const unifiedSsoShell = ssoReady && zitadelEnabled && !localBypass
  const ssoBuildLabel = (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_MC_BUILD_LABEL?.trim()) || '2.0.1'

  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search)
      setLocalBypass(sp.get('local') === '1')
      const hint = sp.get('login_hint')?.trim()
      if (hint) setLoginHintEmail(hint)
      setReturnTo(resolveOidcPostLoginReturnTo())
    } catch {
      setLocalBypass(false)
    }
  }, [])

  useEffect(() => {
    fetch('/api/auth/sso', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        const mode = data?.mode === 'sso_only' || data?.mode === 'sso_primary' ? data.mode : 'off'
        setSsoInfo({
          zitadel: Boolean(data?.zitadel),
          mode,
          registerUrl: typeof data?.registerUrl === 'string' && data.registerUrl.trim() ? data.registerUrl.trim() : null,
          oidcEntryOrigin:
            typeof data?.oidcEntryOrigin === 'string' && data.oidcEntryOrigin.trim()
              ? data.oidcEntryOrigin.trim()
              : null,
        })

        if (data?.hasMcSession) {
          let forceLogin = false
          try {
            forceLogin = new URLSearchParams(window.location.search).get('force_login') === '1'
          } catch {
            forceLogin = false
          }
          if (!forceLogin) {
            const dest = resolveOidcPostLoginReturnTo()
            window.location.replace(dest.startsWith('/') && !dest.startsWith('//') ? dest : '/')
          }
        }
      })
      .catch(() => setSsoInfo({ zitadel: false, mode: 'off', registerUrl: null, oidcEntryOrigin: null }))
      .finally(() => setSsoReady(true))
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined' || !ssoInfo?.zitadel || localBypass) return
    const entry = ssoInfo.oidcEntryOrigin
    if (!entry || window.location.origin === entry) return
    let sp: URLSearchParams
    try {
      sp = new URLSearchParams(window.location.search)
    } catch {
      return
    }
    if (sp.get('stay_host') === '1') return
    const path = window.location.pathname + window.location.search + window.location.hash
    window.location.replace(new URL(path, entry).toString())
  }, [ssoInfo, localBypass])

  const startUnifiedLogin = useCallback(() => {
    if (ssoNavigating) return
    if (!ssoReady) {
      setError(t('checkingLoginOptions'))
      return
    }
    if (!ssoInfo?.zitadel) {
      setError(t('oidcNotConfigured'))
      return
    }
    setError('')
    setSsoNavigating(true)
    // 与 1sheng-console `useAdminSession.startHostedLogin` 一致：始终用当前页 origin 打开 `/api/auth/zitadel`，
    // 避免与 `ZITADEL_REDIRECT_URI` 主机不一致时的跨站导航；主机对齐依赖上方 `location.replace`（及用户直接打开与回调 URI 一致的地址）。
    // login_hint 选填：留空仍发起 OIDC（与 IdP 侧一致）。
    const url = buildZitadelStartLoginUrl({
      returnTo,
      loginHint: loginHintEmail,
    })
    window.location.assign(url)
  }, [ssoNavigating, ssoReady, ssoInfo?.zitadel, returnTo, loginHintEmail, t])

  useEffect(() => {
    try {
      const p = new URLSearchParams(window.location.search)
      const loginError = p.get('login_error')
      if (loginError === 'oidc_denied') setError(t('oidcLoginDenied'))
      else if (loginError === 'oidc_invalid_state') setError(t('oidcLoginInvalidState'))
      else if (loginError === 'oidc_failed') setError(t('oidcLoginFailed'))
      else if (loginError === 'oidc_not_configured') setError(t('oidcNotConfigured'))
      else if (loginError === 'oidc_start_failed') setError(t('oidcStartFailed'))
      else if (loginError === 'tenant_gateway_failed') setError(t('tenantGatewayFailed'))
      else if (loginError === 'tenant_onboarding_no_portal') setError(t('tenantOnboardingNoPortal'))
      else if (loginError === 'tenant_provision_failed') setError(t('tenantProvisionFailed'))
      else if (loginError === 'usercenter_required') setError(t('usercenterRequired'))
      else if (loginError === 'session_pending') setError(t('sessionPendingAfterSso'))
      if (loginError) {
        window.history.replaceState({}, '', '/login')
      }
    } catch {
      // ignore
    }
  }, [t])
  useEffect(() => {
    fetch('/api/setup')
      .then((res) => res.json())
      .then((data) => {
        if (data.needsSetup) {
          window.location.href = '/setup'
        }
      })
      .catch(() => {
        // Ignore — setup check is best-effort
      })
  }, [])

  const completeLogin = useCallback(async (path: string, body: LoginRequestBody) => {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const data = readLoginErrorPayload(await res.json().catch(() => null))
      if (data.code === 'NO_USERS') {
        setNeedsSetup(true)
        setError('')
        setLoading(false)
        setGoogleLoading(false)
        return false
      }
      setError(data.error || t('loginFailed'))
      setNeedsSetup(false)
      setLoading(false)
      setGoogleLoading(false)
      return false
    }

    // Full reload ensures the session cookie is sent on all subsequent requests.
    const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '')
    const next = params.get('next')
    const dest = next && next.startsWith('/') && !next.startsWith('//') ? next.slice(0, 512) : '/'
    window.location.href = dest
    return true
  }, [t])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    // Read DOM values directly to handle browser autofill (which doesn't fire onChange)
    const form = e.target as HTMLFormElement
    const formUsername = (form.elements.namedItem('username') as HTMLInputElement)?.value || username
    const formPassword = (form.elements.namedItem('password') as HTMLInputElement)?.value || password

    try {
      await completeLogin('/api/auth/login', { username: formUsername, password: formPassword })
    } catch {
      setError(t('networkError'))
      setLoading(false)
    }
  }

  // Initialize Google Sign-In SDK (hidden prompt mode)
  useEffect(() => {
    if (!googleClientId || !showLocalLogin) return

    const onScriptLoad = () => {
      if (!window.google) return
      googleCallbackRef.current = async (response: GoogleCredentialResponse) => {
        setError('')
        setGoogleLoading(true)
        try {
          const ok = await completeLogin('/api/auth/google', { credential: response?.credential })
          if (!ok) return
        } catch {
          setError(t('googleSignInFailed'))
          setGoogleLoading(false)
        }
      }
      window.google.accounts.id.initialize({
        client_id: googleClientId,
        callback: (response: GoogleCredentialResponse) => googleCallbackRef.current?.(response),
      })
      setGoogleReady(true)
    }

    const existing = document.querySelector('script[data-google-gsi="1"]') as HTMLScriptElement | null
    if (existing) {
      if (window.google) onScriptLoad()
      return
    }

    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.defer = true
    script.setAttribute('data-google-gsi', '1')
    script.onload = onScriptLoad
    script.onerror = () => setError(t('googleSignInFailed'))
    document.head.appendChild(script)
  }, [googleClientId, completeLogin, t, showLocalLogin])

  const handleGoogleSignIn = () => {
    if (!window.google || !googleReady) return
    window.google.accounts.id.prompt()
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4 void-bg overflow-hidden relative">
      <div className="absolute top-4 right-4 z-50">
        <LanguageSwitcherSelect />
      </div>

      <div className="w-full max-w-[440px] void-panel p-8 md:p-12 animate-fade-in relative z-10">
        {needsSetup && (
          <div className="mb-4 p-4 rounded-lg bg-blue-500/10 border border-blue-500/20 text-center">
            <div className="flex justify-center mb-2">
              <svg className="w-8 h-8 text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>
            <div className="text-sm font-medium text-blue-200">{t('noAdminAccount')}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {t('noAdminDescription')}
            </p>
            <Button
              onClick={() => { window.location.href = '/setup' }}
              size="sm"
              className="mt-3"
            >
              {t('createAdminAccount')}
            </Button>
          </div>
        )}

        {!needsSetup && (
          unifiedSsoShell ? (
          <div className="flex flex-col items-stretch">
              <>
                <div className="flex flex-col items-center text-center">
                  <div className="w-20 h-20 rounded-full overflow-hidden bg-zinc-950 border border-white/15 flex items-center justify-center mb-5 shadow-xl ring-1 ring-red-500/20">
                    <Image
                      src="/brand/app-logo.png"
                      alt=""
                      width={72}
                      height={72}
                      className="h-full w-full object-contain p-2.5"
                      priority
                    />
                  </div>
                  <h1 className="text-2xl font-bold tracking-tight text-foreground">{t('missionControl')}</h1>
                  <p className="mt-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground/90 tabular-nums">
                    {t('ssoActiveBuildLine', { build: ssoBuildLabel })}
                  </p>
                  <p className="mt-6 text-xs text-muted-foreground">{t('securityAuthCenter')}</p>
                  <h2 className="mt-1 text-xl font-bold text-foreground">{t('signInWithUnifiedLogin')}</h2>
                </div>

                {error && (
                  <div role="alert" className="mt-5 p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-sm text-destructive text-center">
                    {error}
                  </div>
                )}

                <form
                  noValidate
                  onSubmit={(e) => {
                    e.preventDefault()
                    startUnifiedLogin()
                  }}
                  className="mt-6 flex flex-col"
                >
                  <div className="relative">
                    <input
                      type="text"
                      name="login_hint"
                      value={loginHintEmail}
                      onChange={(e) => setLoginHintEmail(e.target.value)}
                      className="w-full h-11 pl-3 pr-11 rounded-xl bg-black/35 border border-white/10 text-foreground text-sm placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-red-500/35 focus:border-red-500/40"
                      placeholder={t('loginEmailPlaceholder')}
                      autoComplete="username"
                      aria-label={t('loginEmailPlaceholder')}
                    />
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                      <MailIcon className="w-[18px] h-[18px]" />
                    </span>
                  </div>
                  <p className="mt-2 text-[11px] leading-snug text-muted-foreground/85 text-center px-1">
                    {t('loginHintOptionalLine')}
                  </p>

                  <button
                    type="button"
                    disabled={ssoNavigating}
                    onClick={() => startUnifiedLogin()}
                    className="mt-4 w-full h-12 rounded-full bg-red-600 hover:bg-red-700 text-white text-base font-semibold shadow-lg shadow-red-900/25 transition-colors disabled:opacity-50 disabled:pointer-events-none"
                  >
                    {ssoNavigating ? t('openingUnifiedLogin') : t('signInWithUnifiedLogin')}
                  </button>
                </form>

                {ssoInfo?.registerUrl ? (
                  <a
                    href={ssoInfo.registerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-5 block text-center text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {t('registerAccount')}
                  </a>
                ) : null}
              </>
          </div>
        ) : (
          <>
            <div className="flex flex-col items-center mb-10">
              <div className="w-16 h-16 rounded-2xl overflow-hidden bg-background border border-white/10 flex items-center justify-center mb-6 shadow-2xl">
                <Image
                  src="/brand/app-logo.png"
                  alt=""
                  width={64}
                  height={64}
                  className="h-full w-full object-contain p-2"
                  priority
                />
              </div>
              <h1 className="text-2xl font-bold tracking-tight text-foreground">{t('missionControl')}</h1>
              <p className="text-sm text-muted-foreground mt-2 font-medium opacity-80 text-center px-1">
                {t('signInToContinue')}
              </p>
            </div>

            <>
                {!ssoReady ? (
                  <div className="flex flex-col items-center justify-center gap-3 py-12">
                    <div className="w-9 h-9 border-2 border-muted border-t-muted-foreground/50 rounded-full animate-spin" />
                    <p className="text-sm text-muted-foreground text-center">{t('checkingLoginOptions')}</p>
                  </div>
                ) : (
                  <>
                    {error && (
                      <div role="alert" className="mb-4 p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-sm text-destructive">
                        {error}
                      </div>
                    )}

                    {localBypass && zitadelEnabled && (
                      <div className="mb-3 space-y-2">
                        <div className="p-2.5 rounded-md bg-amber-500/10 border border-amber-500/25 text-xs text-amber-100/90 text-center">
                          {t('ssoOnlyBypassBanner')}
                        </div>
                        <Link href="/login" className="block text-center text-xs text-primary hover:underline">
                          {t('backToUnifiedLogin')}
                        </Link>
                      </div>
                    )}

                    {showLocalLogin && (
                      <>
                        {googleClientId && (
                          <>
                            <button
                              type="button"
                              onClick={handleGoogleSignIn}
                              disabled={!googleReady || googleLoading || loading}
                              className="w-full h-10 flex items-center justify-center gap-3 rounded-lg border border-border bg-white text-[#3c4043] text-sm font-medium hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {googleLoading ? (
                                <>
                                  <div className="w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
                                  {t('signingIn')}
                                </>
                              ) : (
                                <>
                                  <GoogleIcon className="w-[18px] h-[18px]" />
                                  {t('signInWithGoogle')}
                                </>
                              )}
                            </button>
                            {!googleReady && (
                              <p className="text-center text-xs text-muted-foreground mt-2">{t('loadingGoogleSignIn')}</p>
                            )}
                          </>
                        )}

                        {googleClientId && (
                          <div className="my-4 flex items-center gap-2">
                            <div className="h-px flex-1 bg-border" />
                            <span className="text-xs text-muted-foreground">{tc('or')}</span>
                            <div className="h-px flex-1 bg-border" />
                          </div>
                        )}

                        <form onSubmit={handleSubmit} className="space-y-4">
                          <div>
                            <label htmlFor="username" className="block text-sm font-medium text-foreground mb-1.5">{t('username')}</label>
                            <input
                              id="username"
                              type="text"
                              value={username}
                              onChange={(e) => setUsername(e.target.value)}
                              className="w-full h-10 px-3 rounded-lg bg-secondary border border-border text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-smooth"
                              placeholder={t('enterUsername')}
                              autoComplete="username"
                              autoFocus
                              required
                              aria-required="true"
                            />
                          </div>

                          <div>
                            <label htmlFor="password" className="block text-sm font-medium text-foreground mb-1.5">{t('password')}</label>
                            <input
                              id="password"
                              type="password"
                              value={password}
                              onChange={(e) => setPassword(e.target.value)}
                              className="w-full h-10 px-3 rounded-lg bg-secondary border border-border text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-smooth"
                              placeholder={t('enterPassword')}
                              autoComplete="current-password"
                              required
                              aria-required="true"
                            />
                          </div>

                          <Button
                            type="submit"
                            disabled={loading}
                            size="lg"
                            variant="default"
                            className="w-full rounded-lg"
                          >
                            {loading ? (
                              <>
                                <div className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                                {t('signingIn')}
                              </>
                            ) : (
                              t('signIn')
                            )}
                          </Button>
                        </form>
                      </>
                    )}
                  </>
                )}
            </>

            {!unifiedSsoShell && (
              <p className="text-center text-xs text-muted-foreground mt-6">{t('orchestrationTagline')}</p>
            )}
          </>
        ))}
      </div>
    </div>
  )
}
