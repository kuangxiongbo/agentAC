import { describe, expect, it } from 'vitest'
import { mapUsercenterTenantRoleToMcRole } from '@/lib/usercenter-provision-local'

describe('mapUsercenterTenantRoleToMcRole', () => {
  it('maps founder / manager style roles to admin', () => {
    expect(mapUsercenterTenantRoleToMcRole('tenant_founder')).toBe('admin')
    expect(mapUsercenterTenantRoleToMcRole('TENANT_FOUNDER')).toBe('admin')
    expect(mapUsercenterTenantRoleToMcRole('tenant_manager')).toBe('admin')
    expect(mapUsercenterTenantRoleToMcRole('租户创始人')).toBe('admin')
    expect(mapUsercenterTenantRoleToMcRole('租户负责人')).toBe('admin')
    expect(mapUsercenterTenantRoleToMcRole('组织管理员')).toBe('admin')
    expect(mapUsercenterTenantRoleToMcRole('租户管理员')).toBe('admin')
    expect(mapUsercenterTenantRoleToMcRole('owner')).toBe('admin')
    expect(mapUsercenterTenantRoleToMcRole('tenant_owner')).toBe('admin')
  })

  it('maps usercenter tenant admin (sub_admin) and owner-style roles to admin', () => {
    expect(mapUsercenterTenantRoleToMcRole('sub_admin')).toBe('admin')
    expect(mapUsercenterTenantRoleToMcRole('tenant_user_admin')).toBe('admin')
  })

  it('defaults unknown roles to viewer', () => {
    expect(mapUsercenterTenantRoleToMcRole('member')).toBe('viewer')
    expect(mapUsercenterTenantRoleToMcRole('')).toBe('viewer')
  })
})
