/**
 * 开发环境 OIDC 登录表单向 loopback 另一主机名提交时（如页在 localhost、action 在 127.0.0.1），
 * 需在 form-action 中列出显式 origin。Chrome 对 `http://127.0.0.1:*` 在 form-action 上不可靠，会误拦。
 */
export function devFormActionSourcesForOidc(): string[] {
  const out = new Set<string>()
  const rawRedirect = String(process.env.ZITADEL_REDIRECT_URI || '').trim()
  if (rawRedirect) {
    try {
      const o = new URL(rawRedirect).origin
      out.add(o)
      try {
        const u = new URL(o)
        const port = u.port || (u.protocol === 'https:' ? '443' : '80')
        if (u.hostname === '127.0.0.1') {
          out.add(`${u.protocol}//localhost:${port}`)
        } else if (u.hostname === 'localhost') {
          out.add(`${u.protocol}//127.0.0.1:${port}`)
        }
      } catch {
        // ignore peer derivation
      }
    } catch {
      // ignore bad redirect URI
    }
  }
  for (const port of ['5000', '3000', '5001', '3001']) {
    out.add(`http://127.0.0.1:${port}`)
    out.add(`http://localhost:${port}`)
  }
  return [...out]
}

/**
 * `connect-src` 允许的 HTTP(S) / WS 源。
 * 显式列出 loopback 与 OIDC/用户中心域名，避免部分浏览器将 `http://127.0.0.1:*` 判为非法而导致**整段 connect-src 被忽略**，
 * 进而回退到 `default-src 'self'`，出现从 `localhost` 请求 `127.0.0.1`（或反之）的 fetch 被 CSP 拦截。
 */
export function oidcRelatedConnectSrcTokens(extraOrigins: string[] = []): string[] {
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
      // ignore bad redirect URI
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
  for (const raw of extraOrigins) {
    const o = String(raw || '').trim()
    if (o) out.push(o)
  }
  return [...new Set(out)]
}

export function buildAgentCenterCsp(input: {
  nonce: string
  googleEnabled: boolean
  isDev?: boolean
  extraConnectOrigins?: string[]
}): string {
  const { nonce, googleEnabled, isDev = false, extraConnectOrigins = [] } = input
  const scriptSrc = isDev
    ? `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:${googleEnabled ? ' https://accounts.google.com' : ''}`
    : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' blob:${googleEnabled ? ' https://accounts.google.com' : ''}`

  const formAction = isDev
    ? `form-action 'self' ${devFormActionSourcesForOidc().join(' ')}`
    : `form-action 'self'`

  return [
    `default-src 'self'`,
    `base-uri 'self'`,
    `object-src 'none'`,
    `frame-ancestors 'none'`,
    formAction,
    scriptSrc,
    `style-src 'self' 'unsafe-inline'`,
    `style-src-elem 'self' 'unsafe-inline'`,
    `style-src-attr 'unsafe-inline'`,
    `connect-src ${oidcRelatedConnectSrcTokens(extraConnectOrigins).join(' ')}`,
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
