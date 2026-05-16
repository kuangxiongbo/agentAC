export function buildAgentCenterCsp(input: { nonce: string; googleEnabled: boolean; isDev?: boolean }): string {
  const { nonce, googleEnabled, isDev = false } = input
  const connectTokens = (() => {
    const out: string[] = ["'self'", 'ws:', 'wss:']
    for (const port of ['5000', '3000', '5001', '3001']) {
      out.push(`http://127.0.0.1:${port}`, `http://localhost:${port}`)
    }
    const rawRedirect = String(process.env.ZITADEL_REDIRECT_URI || '').trim()
    if (rawRedirect) {
      try {
        const o = new URL(rawRedirect).origin
        out.push(o)
        const u = new URL(o)
        const port = u.port || (u.protocol === 'https:' ? '443' : '80')
        if (u.hostname === '127.0.0.1') {
          out.push(`${u.protocol}//localhost:${port}`)
        } else if (u.hostname === 'localhost') {
          out.push(`${u.protocol}//127.0.0.1:${port}`)
        }
      } catch {
        // ignore
      }
    }
    for (const key of ['ZITADEL_ISSUER', 'USER_CENTER_API_URL', 'USERCENTER_ORIGIN'] as const) {
      const raw = String(process.env[key] || '').trim()
      if (!raw) continue
      try {
        out.push(new URL(raw).origin)
      } catch {
        // ignore
      }
    }
    out.push('https://cdn.jsdelivr.net')
    return [...new Set(out)]
  })()
  const scriptSrc = isDev
    ? `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:${googleEnabled ? ' https://accounts.google.com' : ''}`
    : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' blob:${googleEnabled ? ' https://accounts.google.com' : ''}`

  return [
    `default-src 'self'`,
    `base-uri 'self'`,
    `object-src 'none'`,
    `frame-ancestors 'none'`,
    scriptSrc,
    `style-src 'self' 'unsafe-inline'`,
    `style-src-elem 'self' 'unsafe-inline'`,
    `style-src-attr 'unsafe-inline'`,
    `connect-src ${connectTokens.join(' ')}`,
    `img-src 'self' data: blob:${googleEnabled ? ' https://*.googleusercontent.com https://lh3.googleusercontent.com' : ''}`,
    `font-src 'self' data:`,
    `frame-src 'self'${googleEnabled ? ' https://accounts.google.com' : ''}`,
    `worker-src 'self' blob:`,
  ].join('; ')
}

export function buildNonceRequestHeaders(input: {
  headers: Headers
  nonce: string
  googleEnabled: boolean
  isDev?: boolean
}): Headers {
  const requestHeaders = new Headers(input.headers)
  const csp = buildAgentCenterCsp({ nonce: input.nonce, googleEnabled: input.googleEnabled, isDev: input.isDev })

  requestHeaders.set('x-nonce', input.nonce)
  requestHeaders.set('Content-Security-Policy', csp)

  return requestHeaders
}
