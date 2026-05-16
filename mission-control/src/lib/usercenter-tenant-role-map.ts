/**
 * 将用户中心 `tenant.role`（如 `uc_tenant_members.role`）映射为 Mission Control 的 `users.role`。
 * 与 `usercenter-provision-local` 共用，供会话校验时纠偏本地库中陈旧角色。
 */
export function mapUsercenterTenantRoleToMcRole(role: string): 'admin' | 'operator' | 'viewer' {
  const raw = String(role || '').trim()
  const r = raw.toLowerCase().replace(/\s+/g, '_')
  // 奕升 / 用户中心：`owner`（所有人）与 `sub_admin`（租户管理员）均需租户级管理能力（含设置页）
  if (
    r === 'owner'
    || r === 'tenant_owner'
    || r === 'tenantowner'
    || r === 'founder'
    || r === 'tenant_founder'
    || r === 'tenantfounder'
    || r === 'tenant_manager'
    || r === 'tenantmanager'
    || r === 'org_admin'
    || r === 'orgadmin'
    || r === 'sub_admin'
    || r === 'subadmin'
    || r === 'tenant_admin'
    || r === 'tenantadmin'
    || r === 'tenant_user_admin'
    || r === 'tenantuseradmin'
  ) {
    return 'admin'
  }
  if (/创始人|负责人|租户创始人|租户负责人|组织管理员|租户管理员/.test(raw)) {
    return 'admin'
  }
  return 'viewer'
}
