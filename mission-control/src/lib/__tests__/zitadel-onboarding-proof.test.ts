import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  signZitadelOnboardingProof,
  verifyZitadelOnboardingProof,
} from '@/lib/zitadel-onboarding-proof'

describe('zitadel-onboarding-proof', () => {
  const prev = process.env.AUTH_SECRET

  beforeEach(() => {
    process.env.AUTH_SECRET = 'unit-test-auth-secret-32chars!!'
  })

  afterEach(() => {
    if (prev === undefined) delete process.env.AUTH_SECRET
    else process.env.AUTH_SECRET = prev
  })

  it('round-trips proof payload', () => {
    const token = signZitadelOnboardingProof({
      zitadelSub: 'sub-1',
      email: 'u@example.com',
      displayName: 'User',
      returnTo: '/tasks',
    })
    const proof = verifyZitadelOnboardingProof(token)
    expect(proof).toEqual({
      zitadelSub: 'sub-1',
      email: 'u@example.com',
      displayName: 'User',
      returnTo: '/tasks',
    })
  })
})
