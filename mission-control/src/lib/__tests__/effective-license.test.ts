import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { generateKeyPairSync, createSign } from 'node:crypto'
import { runMigrations } from '@/lib/migrations'
import { offlineLicenseSettingKey, setLicenseSetting } from '@/lib/license-settings-store'
import { resolveEffectiveLicense, type LicFile } from '@/lib/effective-license'

const verifyLicenseMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/license-verifier', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/license-verifier')>()
  return {
    ...actual,
    verifyLicense: verifyLicenseMock,
  }
})

describe('resolveEffectiveLicense', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
    verifyLicenseMock.mockReset()
    process.env.MC_LICENSE_ENFORCE = 'true'
  })

  afterEach(() => {
    db.close()
    delete process.env.MC_LICENSE_ENFORCE
  })

  function saveValidOfflineLicense(entitlements: Record<string, unknown>) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const payload: LicFile['payload'] = {
      version: 1,
      appId: 'agentCenter',
      tenantId: '1',
      hardwareId: null,
      entitlements,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    }
    const sign = createSign('SHA256')
    sign.update(JSON.stringify(payload))
    sign.end()
    const lic: LicFile = {
      payload,
      signature: sign.sign(privateKey, 'base64'),
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    }
    setLicenseSetting(
      offlineLicenseSettingKey('1'),
      JSON.stringify(lic),
      { category: 'license', description: 'test offline license' },
      db,
    )
  }

  it('does not use stale offline license when user center explicitly rejects subscription', async () => {
    saveValidOfflineLicense({ enableHumanWatch: true, enableLocalCliElevation: true })
    verifyLicenseMock.mockResolvedValue({
      licensed: false,
      reason: 'unsubscribed',
      entitlements: { enableHumanWatch: false, enableLocalCliElevation: false },
      expiresAt: null,
    })

    const license = await resolveEffectiveLicense({ tenantId: 1, zitadelSub: 'sub-1' }, db)

    expect(license.source).toBe('default')
    expect(license.licensed).toBe(false)
    expect(license.allowed).toBe(false)
    expect(license.entitlements.enableLocalCliElevation).toBe(false)
  })

  it('uses offline license only as fallback when online verification errors', async () => {
    saveValidOfflineLicense({ enableHumanWatch: true, enableLocalCliElevation: true })
    verifyLicenseMock.mockResolvedValue({
      licensed: false,
      reason: 'error',
      entitlements: { enableHumanWatch: false, enableLocalCliElevation: false },
      expiresAt: null,
    })

    const license = await resolveEffectiveLicense({ tenantId: 1, zitadelSub: 'sub-1' }, db)

    expect(license.source).toBe('offline')
    expect(license.licensed).toBe(true)
    expect(license.allowed).toBe(true)
    expect(license.entitlements.enableLocalCliElevation).toBe(true)
  })
})
