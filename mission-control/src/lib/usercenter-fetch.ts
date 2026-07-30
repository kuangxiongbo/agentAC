import https from 'node:https'

function tlsInsecureEnabled(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    String(process.env.MC_USERCENTER_TLS_INSECURE || '').trim().toLowerCase(),
  )
}

function flattenHeaders(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {}
  return Object.fromEntries(new Headers(headers).entries())
}

/** Fetch a user-center endpoint with an explicitly scoped self-signed TLS opt-in. */
export async function userCenterFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (!url.startsWith('https:') || !tlsInsecureEnabled()) return fetch(url, init)

  const target = new URL(url)
  return await new Promise<Response>((resolve, reject) => {
    const req = https.request({
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method: init.method || 'GET',
      headers: flattenHeaders(init.headers),
      rejectUnauthorized: false,
      signal: init.signal || undefined,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), {
        status: res.statusCode || 500,
        statusText: res.statusMessage,
        headers: res.headers as HeadersInit,
      })))
    })
    req.on('error', reject)
    if (init.body != null) {
      if (typeof init.body !== 'string' && !Buffer.isBuffer(init.body)) {
        req.destroy(new TypeError('Scoped user-center TLS fetch requires a string or Buffer body'))
        return
      }
      req.write(init.body)
    }
    req.end()
  })
}

export const __test__ = { tlsInsecureEnabled }
