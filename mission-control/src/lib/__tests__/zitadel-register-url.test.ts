import { describe, expect, it } from 'vitest'
import { resolveZitadelRegisterUrl } from '@/lib/zitadel-register-url'

describe('resolveZitadelRegisterUrl', () => {
  it('prefers ZITADEL_REGISTER_URL', () => {
    const url = resolveZitadelRegisterUrl({
      ZITADEL_REGISTER_URL: 'https://sso.example.com/custom/register',
      ZITADEL_ISSUER: 'https://ignored.example/',
    })
    expect(url).toBe('https://sso.example.com/custom/register')
  })

  it('falls back to issuer /ui/login/register', () => {
    expect(
      resolveZitadelRegisterUrl({
        ZITADEL_ISSUER: 'https://sso.1sheng.work',
      })
    ).toBe('https://sso.1sheng.work/ui/login/register')
  })

  it('normalizes issuer trailing slash', () => {
    expect(
      resolveZitadelRegisterUrl({
        ZITADEL_ISSUER: 'https://sso.1sheng.work/',
      })
    ).toBe('https://sso.1sheng.work/ui/login/register')
  })

  it('returns null when nothing usable is set', () => {
    expect(resolveZitadelRegisterUrl({})).toBeNull()
  })
})
