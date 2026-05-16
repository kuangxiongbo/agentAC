import { createHash, createPublicKey, createVerify, randomBytes, constants as cryptoConstants } from 'node:crypto'
/** OIDC 发现、授权与 token；与奕升 `1sheng-console/server/oidc/hosted.ts`、`server/config/oidc.ts`（ZITADEL_*）对齐。 */
import http from 'node:http'
import https from 'node:https'

type JsonRecord = Record<string, unknown>

type OidcDiscovery = {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint?: string
  jwks_uri: string
  end_session_endpoint?: string
}

type OidcJwk = JsonRecord & { kid?: string; alg?: string; kty?: string; use?: string }

export type VerifiedIdTokenClaims = {
  sub: string
  email: string | null
  preferredUsername: string | null
  name: string | null
  nonce: string | null
}

export type OidcUserInfo = {
  sub: string
  email: string | null
  preferredUsername: string | null
  name: string | null
}

let discoveryCache: OidcDiscovery | null = null
let jwksCache: { expiresAt: number; keys: OidcJwk[] } | null = null

function env(name: string): string {
  return String(process.env[name] || '').trim()
}

export function getZitadelOidcConfig() {
  return {
    issuer: env('ZITADEL_ISSUER'),
    clientId: env('ZITADEL_CLIENT_ID'),
    clientSecret: env('ZITADEL_CLIENT_SECRET'),
    redirectUri: env('ZITADEL_REDIRECT_URI'),
    postLogoutRedirectUri: env('ZITADEL_POST_LOGOUT_REDIRECT_URI'),
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64url')
}

function base64UrlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url')
}

function parseJson<T = unknown>(text: string): T {
  return JSON.parse(text) as T
}

function oidcTlsInsecure(): boolean {
  const v = String(process.env.MC_OIDC_TLS_INSECURE || '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

function flattenHeaders(h: RequestInit['headers'] | undefined): Record<string, string> {
  if (!h) return {}
  if (h instanceof Headers) {
    const o: Record<string, string> = {}
    h.forEach((value, key) => {
      o[key] = value
    })
    return o
  }
  if (Array.isArray(h)) {
    return Object.fromEntries(h)
  }
  return h as Record<string, string>
}

function formatFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const parts: string[] = [err.message]
  let c: unknown = (err as Error & { cause?: unknown }).cause
  for (let i = 0; i < 8 && c != null; i++) {
    if (c instanceof Error) {
      parts.push(c.message)
      c = (c as Error & { cause?: unknown }).cause
    } else {
      parts.push(String(c))
      break
    }
  }
  return parts.join(' | ')
}

/** 当 MC_OIDC_TLS_INSECURE=1 时，对 https OIDC 请求跳过 TLS 校验（仅开发/内网自签证书，勿用于生产公网）。 */
async function oidcHttpsRequest(input: {
  urlStr: string
  method: string
  headers: Record<string, string>
  body?: string
}): Promise<{ ok: boolean; status: number; text: string }> {
  const u = new URL(input.urlStr)
  return await new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: input.method,
        headers: input.headers,
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          const status = res.statusCode ?? 0
          resolve({ ok: status >= 200 && status < 300, status, text })
        })
      }
    )
    req.on('error', reject)
    if (input.body) req.write(input.body)
    req.end()
  })
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const method = (init?.method || 'GET').toUpperCase()
  const headers = flattenHeaders(init?.headers)
  const body = typeof init?.body === 'string' ? init.body : undefined

  let result: { ok: boolean; status: number; text: string }
  try {
    if (url.startsWith('https:') && oidcTlsInsecure()) {
      result = await oidcHttpsRequest({ urlStr: url, method, headers, body })
    } else if (url.startsWith('http:') && oidcTlsInsecure()) {
      const u = new URL(url)
      result = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: u.hostname,
            port: u.port || 80,
            path: `${u.pathname}${u.search}`,
            method,
            headers,
          },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (chunk) => chunks.push(chunk))
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8')
              const status = res.statusCode ?? 0
              resolve({ ok: status >= 200 && status < 300, status, text })
            })
          }
        )
        req.on('error', reject)
        if (body) req.write(body)
        req.end()
      })
    } else {
      const resp = await fetch(url, init)
      result = { ok: resp.ok, status: resp.status, text: await resp.text() }
    }
  } catch (err) {
    throw new Error(formatFetchError(err))
  }
  if (!result.ok) {
    throw new Error(`OIDC 请求失败 ${result.status}: ${result.text || 'Unknown'}`)
  }
  return result.text.trim() ? parseJson(result.text) : null
}

export function oidcIsConfigured(): boolean {
  const cfg = getZitadelOidcConfig()
  const authSecret = String(process.env.AUTH_SECRET || '').trim()
  return Boolean(cfg.issuer && cfg.clientId && cfg.clientSecret && cfg.redirectUri && authSecret)
}

export async function getOidcDiscovery(): Promise<OidcDiscovery> {
  const cfg = getZitadelOidcConfig()
  if (discoveryCache) return discoveryCache
  if (!cfg.issuer) throw new Error('缺少 ZITADEL_ISSUER')
  const url = `${cfg.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`
  const raw = await fetchJson(url)
  if (!isRecord(raw)) throw new Error('OIDC discovery 返回无效数据')
  const discovery: OidcDiscovery = {
    issuer: readString(raw.issuer) || cfg.issuer.replace(/\/+$/, ''),
    authorization_endpoint: readString(raw.authorization_endpoint),
    token_endpoint: readString(raw.token_endpoint),
    userinfo_endpoint: readString(raw.userinfo_endpoint) || undefined,
    jwks_uri: readString(raw.jwks_uri),
    end_session_endpoint: readString(raw.end_session_endpoint) || undefined,
  }
  if (!discovery.authorization_endpoint || !discovery.token_endpoint || !discovery.jwks_uri) {
    throw new Error('OIDC discovery 缺少关键端点')
  }
  discoveryCache = discovery
  return discovery
}

async function getJwks(): Promise<OidcJwk[]> {
  const now = Date.now()
  if (jwksCache && jwksCache.expiresAt > now && Array.isArray(jwksCache.keys)) {
    return jwksCache.keys
  }
  const discovery = await getOidcDiscovery()
  const raw = await fetchJson(discovery.jwks_uri)
  if (!isRecord(raw) || !Array.isArray(raw.keys)) {
    throw new Error('JWKS 返回无效数据')
  }
  const keys = raw.keys.filter((k): k is OidcJwk => isRecord(k))
  jwksCache = { keys, expiresAt: now + 10 * 60 * 1000 }
  return keys
}

function verifyJwtSignature(input: {
  signingInput: string
  signature: Buffer
  jwk: OidcJwk
  alg: string
}): boolean {
  const publicKey = createPublicKey({ key: input.jwk as JsonRecord, format: 'jwk' })
  const algo =
    input.alg === 'RS384' || input.alg === 'PS384'
      ? 'RSA-SHA384'
      : input.alg === 'RS512' || input.alg === 'PS512'
        ? 'RSA-SHA512'
        : 'RSA-SHA256'
  const verify = createVerify(algo)
  verify.update(input.signingInput)
  verify.end()
  if (input.alg.startsWith('PS')) {
    return verify.verify(
      {
        key: publicKey,
        padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
        saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
      },
      input.signature
    )
  }
  return verify.verify(publicKey, input.signature)
}

export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(randomBytes(32))
  const challenge = base64UrlEncode(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export function randomUrlToken(bytes = 24): string {
  return base64UrlEncode(randomBytes(bytes))
}

export async function buildAuthorizationUrl(input: {
  state: string
  nonce: string
  codeChallenge: string
  loginHint?: string | null
}): Promise<string> {
  const cfg = getZitadelOidcConfig()
  const discovery = await getOidcDiscovery()
  const url = new URL(discovery.authorization_endpoint)
  url.searchParams.set('client_id', cfg.clientId)
  url.searchParams.set('redirect_uri', cfg.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'openid profile email')
  url.searchParams.set('state', input.state)
  url.searchParams.set('nonce', input.nonce)
  url.searchParams.set('code_challenge', input.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  const hint = readString(input.loginHint)
  if (hint) url.searchParams.set('login_hint', hint)
  return url.toString()
}

export async function exchangeCodeForTokens(input: {
  code: string
  codeVerifier: string
}): Promise<{ accessToken: string; idToken: string }> {
  const cfg = getZitadelOidcConfig()
  const discovery = await getOidcDiscovery()
  const params = new URLSearchParams()
  params.set('grant_type', 'authorization_code')
  params.set('code', input.code)
  params.set('redirect_uri', cfg.redirectUri)
  params.set('client_id', cfg.clientId)
  params.set('client_secret', cfg.clientSecret)
  params.set('code_verifier', input.codeVerifier)
  const raw = await fetchJson(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })
  if (!isRecord(raw)) throw new Error('token 交换返回无效数据')
  const accessToken = readString(raw.access_token)
  const idToken = readString(raw.id_token)
  if (!accessToken || !idToken) throw new Error('token 交换未返回 access_token / id_token')
  return { accessToken, idToken }
}

export async function verifyIdToken(idToken: string, expectedNonce: string): Promise<VerifiedIdTokenClaims> {
  const cfg = getZitadelOidcConfig()
  const parts = String(idToken || '').split('.')
  if (parts.length !== 3) throw new Error('id_token 格式无效')
  const [headerB64, payloadB64, sigB64] = parts
  const header = parseJson<JsonRecord>(base64UrlDecode(headerB64).toString('utf8'))
  const payload = parseJson<JsonRecord>(base64UrlDecode(payloadB64).toString('utf8'))
  const alg = readString(header.alg)
  const kid = readString(header.kid)
  if (!alg || !kid) throw new Error('id_token 头缺少 alg / kid')
  if (!['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512'].includes(alg)) {
    throw new Error(`不支持的 id_token 算法：${alg}`)
  }
  const jwks = await getJwks()
  const jwk = jwks.find((k) => readString(k.kid) === kid)
  if (!jwk) throw new Error('未在 JWKS 中找到匹配的 kid')
  const ok = verifyJwtSignature({
    signingInput: `${headerB64}.${payloadB64}`,
    signature: base64UrlDecode(sigB64),
    jwk,
    alg,
  })
  if (!ok) throw new Error('id_token 签名校验失败')

  const discovery = await getOidcDiscovery()
  const iss = readString(payload.iss)
  const audRaw = payload.aud
  const audList = Array.isArray(audRaw) ? audRaw.map((v) => readString(v)).filter(Boolean) : [readString(audRaw)]
  const exp = Number(payload.exp || 0)
  const now = Math.floor(Date.now() / 1000)
  if (iss !== discovery.issuer) throw new Error('id_token issuer 不匹配')
  if (!audList.includes(cfg.clientId)) throw new Error('id_token audience 不匹配')
  if (!exp || exp < now - 60) throw new Error('id_token 已过期')
  const nonce = readString(payload.nonce) || null
  if (expectedNonce && nonce !== expectedNonce) throw new Error('id_token nonce 不匹配')

  return {
    sub: readString(payload.sub),
    email: readString(payload.email) || null,
    preferredUsername: readString(payload.preferred_username) || null,
    name: readString(payload.name) || null,
    nonce,
  }
}

export async function fetchOidcUserInfo(accessToken: string): Promise<OidcUserInfo | null> {
  const discovery = await getOidcDiscovery()
  if (!discovery.userinfo_endpoint) return null
  const raw = await fetchJson(discovery.userinfo_endpoint, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!isRecord(raw)) return null
  return {
    sub: readString(raw.sub),
    email: readString(raw.email) || null,
    preferredUsername: readString(raw.preferred_username) || null,
    name: readString(raw.name) || null,
  }
}

export async function buildEndSessionUrl(idTokenHint?: string | null): Promise<string | null> {
  const cfg = getZitadelOidcConfig()
  const discovery = await getOidcDiscovery()
  if (!discovery.end_session_endpoint) return null
  const url = new URL(discovery.end_session_endpoint)
  url.searchParams.set('client_id', cfg.clientId)
  const postLogout = readString(cfg.postLogoutRedirectUri)
  if (postLogout) url.searchParams.set('post_logout_redirect_uri', postLogout)
  const hint = readString(idTokenHint || '')
  if (hint) url.searchParams.set('id_token_hint', hint)
  return url.toString()
}
