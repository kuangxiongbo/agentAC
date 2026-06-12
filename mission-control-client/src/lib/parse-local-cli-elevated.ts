import type { LocalCliPermissionMode } from './local-cli-permission'

export function isLocalCliElevatedFlag(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1'
}

export function elevatedFlagToPermissionMode(elevated: boolean): LocalCliPermissionMode | undefined {
  return elevated ? 'full' : undefined
}
