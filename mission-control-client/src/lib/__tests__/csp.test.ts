import { afterEach, describe, expect, it } from 'vitest'
import {
  buildAgentCenterCsp,
  buildNonceRequestHeaders,
  devFormActionSourcesForOidc,
  oidcRelatedConnectSrcTokens,
} from '@/lib/csp'

describe('devFormActionSourcesForOidc', () => {
  it('includes ZITADEL_REDIRECT_URI origin and localhost peer on dev loopback', () => {
    const prev = process.env.ZITADEL_REDIRECT_URI
    process.env.ZITADEL_REDIRECT_URI = 'http://127.0.0.1:5000/api/auth/callback'
    try {
      const list = devFormActionSourcesForOidc()
      expect(list).toContain('http://127.0.0.1:5000')
      expect(list).toContain('http://localhost:5000')
    } finally {
      if (prev === undefined) delete process.env.ZITADEL_REDIRECT_URI
      else process.env.ZITADEL_REDIRECT_URI = prev
    }
  })
})

describe('buildAgentCenterCsp', () => {
  it('includes the request nonce and production-safe inline script fallback', () => {
    const csp = buildAgentCenterCsp({ nonce: 'nonce-123', googleEnabled: false })

    expect(csp).toContain(`script-src 'self' 'unsafe-inline' 'nonce-nonce-123'`)
    expect(csp).not.toContain('strict-dynamic')
    expect(csp).toContain("style-src 'self' 'unsafe-inline'")
    expect(csp).toContain("style-src-elem 'self' 'unsafe-inline'")
    expect(csp).toContain("style-src-attr 'unsafe-inline'")
  })

  it('relaxes script-src in development mode (no nonce / strict-dynamic)', () => {
    const csp = buildAgentCenterCsp({ nonce: 'nonce-123', googleEnabled: false, isDev: true })

    expect(csp).toContain(`script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:`)
    expect(csp).not.toContain('strict-dynamic')
    expect(csp).toContain("form-action 'self'")
    expect(csp).toContain('http://127.0.0.1:5000')
    expect(csp).toContain('http://localhost:5000')
  })

  it('restricts form-action to self in production CSP', () => {
    const csp = buildAgentCenterCsp({ nonce: 'n', googleEnabled: false, isDev: false })
    expect(csp).toContain("form-action 'self'")
    const formAction = csp.split(';').find((part) => part.trim().startsWith('form-action')) || ''
    expect(formAction).not.toContain('http://127.0.0.1:5000')
  })
})

describe('buildNonceRequestHeaders', () => {
  it('propagates nonce and CSP into request headers for Next.js rendering', () => {
    const headers = buildNonceRequestHeaders({
      headers: new Headers({ host: 'localhost:3000' }),
      nonce: 'nonce-123',
      googleEnabled: false,
      isDev: true,
    })

    expect(headers.get('x-nonce')).toBe('nonce-123')
    expect(headers.get('Content-Security-Policy')).toContain("'unsafe-eval'")
    expect(headers.get('Content-Security-Policy')).toContain("style-src 'self' 'unsafe-inline'")
  })
})
