import { ROLE_BASE_PERMISSIONS, ROLE_WEIGHT, type Permission, type Role } from './enums'

/** 参与权限计算的最小成员信息 */
export interface PermissionCarrier {
  role: Role
  /** 额外授予的权限位 */
  allow: number
  /** 显式剥夺的权限位，优先级高于 allow 与角色默认 */
  deny: number
}

/** 有效权限 = (角色默认 | 额外允许) & ~显式拒绝 */
export function effectivePermissions(member: PermissionCarrier): number {
  return (ROLE_BASE_PERMISSIONS[member.role] | member.allow) & ~member.deny
}

export function hasPermission(member: PermissionCarrier, bit: Permission): boolean {
  return (effectivePermissions(member) & bit) !== 0
}

/** 角色权重比较：返回 true 表示 actor 有权管理 target */
export function outranks(actorRole: Role, targetRole: Role, isSelf: boolean): boolean {
  if (isSelf) return false
  return ROLE_WEIGHT[actorRole] > ROLE_WEIGHT[targetRole]
}
