import {
  effectivePermissions,
  hasPermission,
  outranks,
  type Permission,
  type Role,
} from '@nenochat/shared'
import type { DB } from '../db'
import * as membersRepo from '../db/repo/members'
import { err } from '../util/errors'

export function permissionsOf(member: membersRepo.MemberRow): number {
  return effectivePermissions({
    role: member.role as Role,
    allow: member.allow,
    deny: member.deny,
  })
}

export function can(member: membersRepo.MemberRow, bit: Permission): boolean {
  return hasPermission({ role: member.role as Role, allow: member.allow, deny: member.deny }, bit)
}

/** 校验当前用户对某会话拥有指定权限，同时返回其成员记录 */
export function assertPermission(
  db: DB,
  conversationId: string,
  userId: string,
  bit: Permission,
): membersRepo.MemberRow {
  const member = membersRepo.findActive(db, conversationId, userId)
  if (!member) throw err.forbidden('你不在这个会话中')
  if (!can(member, bit)) throw err.forbidden('没有权限执行此操作')
  return member
}

/** 成员关系校验，不需要额外权限位 */
export function assertMember(db: DB, conversationId: string, userId: string): membersRepo.MemberRow {
  const member = membersRepo.findActive(db, conversationId, userId)
  if (!member) throw err.forbidden('你不在这个会话中')
  return member
}

/** 管理他人时要求操作者角色权重更高，且不能对自己操作 */
export function assertOutranks(actor: membersRepo.MemberRow, target: membersRepo.MemberRow): void {
  if (actor.user_id === target.user_id) throw err.forbidden('不能对自己执行该操作')
  if (!outranks(actor.role as Role, target.role as Role, false)) {
    throw err.forbidden('对方角色不低于你，无法管理')
  }
}

/** 是否被禁言（禁言到期的记录视为未禁言） */
export function isMuted(member: membersRepo.MemberRow, at: number = Date.now()): boolean {
  return member.mute_until !== null && member.mute_until > at
}
