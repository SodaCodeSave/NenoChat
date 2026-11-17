import {
  ConversationType,
  Permission,
  Role,
  dmKey,
  type Conversation,
  type Member,
} from '@nenochat/shared'
import type { DB } from '../db'
import { withTx } from '../db/tx'
import * as aiRepo from '../db/repo/ai'
import * as conversationsRepo from '../db/repo/conversations'
import * as membersRepo from '../db/repo/members'
import * as usersRepo from '../db/repo/users'
import { writeChange } from './change-log'
import { assertMember, assertOutranks, assertPermission } from './permission-service'
import { err } from '../util/errors'
import { now } from '../util/clock'
import { emitConversationUpdated, emitMemberRemoved, emitMemberUpserted } from '../ws/emitter'

export interface ConversationSummary extends Conversation {
  pinnedAt?: number | null
  notificationLevel?: string | null
  memberCount?: number
  unreadCount?: number
  mentionCount?: number
  myLastReadSeq?: number
  /** 私聊对方资料，列表渲染直接用，不必再查成员 */
  partnerId?: string | null
  partnerName?: string | null
  partnerAvatarUrl?: string | null
}

export function list(db: DB, userId: string): ConversationSummary[] {
  return conversationsRepo.listForUser(db, userId).map((row) => ({
    ...conversationsRepo.mapConversation(row),
    pinnedAt: row.pinned_at,
    notificationLevel: row.notification_level,
    memberCount: row.member_count,
    unreadCount: row.unread_count,
    mentionCount: row.mention_count,
    myLastReadSeq: row.my_last_read_seq,
    partnerId: row.partner_id,
    partnerName: row.partner_name,
    partnerAvatarUrl: row.partner_avatar_url,
  }))
}

export interface DetailResult {
  conversation: Conversation
  me: Member
  members: Array<Member & { user: ReturnType<typeof usersRepo.mapPublicUser> | null }>
}

export function detail(db: DB, conversationId: string, userId: string): DetailResult {
  const member = assertMember(db, conversationId, userId)
  const conv = conversationsRepo.findById(db, conversationId)
  if (!conv || conv.deleted_at !== null) throw err.notFound('会话不存在')

  const memberRows = membersRepo.listActive(db, conversationId)
  const userMap = new Map(
    usersRepo
      .listByIds(
        db,
        memberRows.map((m) => m.user_id),
      )
      .map((u) => [u.id, u]),
  )

  return {
    conversation: conversationsRepo.mapConversation(conv),
    me: membersRepo.mapMember(member),
    members: memberRows.map((row) => {
      const user = userMap.get(row.user_id)
      return {
        ...membersRepo.mapMember(row),
        user: user ? usersRepo.mapPublicUser(user) : null,
      }
    }),
  }
}

/** 私聊幂等：同一对用户永远只有一个 direct 会话 */
export function openDirect(db: DB, userId: string, targetUserId: string): Conversation {
  if (userId === targetUserId) throw err.validation('不能和自己创建私聊')

  const target = usersRepo.findById(db, targetUserId)
  if (!target) throw err.notFound('用户不存在')

  const key = dmKey(userId, targetUserId)
  const existing = conversationsRepo.findByDmKey(db, key)
  if (existing) {
    // 曾退出过私聊的成员重新加入
    withTx(db, () => {
      if (!membersRepo.findActive(db, existing.id, userId)) {
        membersRepo.upsert(db, { conversationId: existing.id, userId })
      }
      if (!membersRepo.findActive(db, existing.id, targetUserId)) {
        membersRepo.upsert(db, { conversationId: existing.id, userId: targetUserId })
      }
    })
    return conversationsRepo.mapConversation(existing)
  }

  const conv = withTx(db, () => {
    const row = conversationsRepo.create(db, {
      type: ConversationType.Direct,
      name: null,
      ownerId: userId,
      dmKey: key,
    })
    membersRepo.upsert(db, { conversationId: row.id, userId, role: Role.Owner })
    membersRepo.upsert(db, { conversationId: row.id, userId: targetUserId, role: Role.Member })

    const mapped = conversationsRepo.mapConversation(row)
    writeChange(db, {
      entity: 'conversation',
      entityId: row.id,
      op: 'upsert',
      conversationId: row.id,
      payload: mapped,
      actorId: userId,
    })
    return mapped
  })

  emitConversationUpdated(db, conv)
  return conv
}

export interface CreateGroupInput {
  name: string
  memberIds?: string[]
  avatarUrl?: string | null
}

/**
 * 真人成员随便拉；AI 角色只能由它的主人拉进群，
 * 避免别人拿你的角色和密钥去聊天、替你花钱。
 */
function assertAddableUsers(db: DB, actorId: string, userIds: string[]): void {
  for (const id of Array.from(new Set(userIds))) {
    const user = usersRepo.findById(db, id)
    if (!user) throw err.notFound('用户不存在')

    if (user.is_bot === 1) {
      const persona = aiRepo.findPersonaByUserId(db, id)
      if (!persona || persona.owner_id !== actorId) {
        throw err.forbidden('只能把自己的 AI 角色拉进群')
      }
    }
  }
}

export function createGroup(db: DB, userId: string, input: CreateGroupInput): DetailResult {
  const members = Array.from(new Set([userId, ...(input.memberIds ?? [])]))
  assertAddableUsers(db, userId, members)

  const conversationId = withTx(db, () => {
    const row = conversationsRepo.create(db, {
      type: ConversationType.Group,
      name: input.name,
      avatarUrl: input.avatarUrl ?? null,
      ownerId: userId,
    })

    for (const memberId of members) {
      membersRepo.upsert(db, {
        conversationId: row.id,
        userId: memberId,
        role: memberId === userId ? Role.Owner : Role.Member,
        invitedBy: userId,
      })
    }

    const mapped = conversationsRepo.mapConversation(row)
    writeChange(db, {
      entity: 'conversation',
      entityId: row.id,
      op: 'upsert',
      conversationId: row.id,
      payload: mapped,
      actorId: userId,
    })
    return row.id
  })

  return detail(db, conversationId, userId)
}

export interface UpdateConversationInput {
  name?: string
  avatarUrl?: string | null
  announcement?: string | null
}

export function update(
  db: DB,
  conversationId: string,
  userId: string,
  patch: UpdateConversationInput,
): Conversation {
  const conv = withTx(db, () => {
    // 改公告需要单独的管理权限，改名/头像同样走会话管理权限
    assertPermission(db, conversationId, userId, Permission.MANAGE_CONVERSATION)

    const row = conversationsRepo.update(db, conversationId, {
      ...patch,
      announcementUpdatedBy: patch.announcement !== undefined ? userId : undefined,
    })
    const mapped = conversationsRepo.mapConversation(row)
    writeChange(db, {
      entity: 'conversation',
      entityId: row.id,
      op: 'upsert',
      conversationId: row.id,
      payload: mapped,
      actorId: userId,
    })
    return mapped
  })

  emitConversationUpdated(db, conv)
  return conv
}

export function addMembers(db: DB, conversationId: string, actorId: string, userIds: string[]): Member[] {
  assertPermission(db, conversationId, actorId, Permission.MANAGE_MEMBERS)
  assertAddableUsers(db, actorId, userIds)

  const added = withTx(db, () => {
    const result: membersRepo.MemberRow[] = []
    for (const userId of Array.from(new Set(userIds))) {
      if (!usersRepo.findById(db, userId)) continue
      if (membersRepo.findActive(db, conversationId, userId)) continue
      const row = membersRepo.upsert(db, { conversationId, userId, invitedBy: actorId })
      writeChange(db, {
        entity: 'member',
        entityId: userId,
        op: 'upsert',
        conversationId,
        payload: membersRepo.mapMember(row),
        actorId,
      })
      result.push(row)
    }
    return result
  })

  for (const row of added) {
    const user = usersRepo.findById(db, row.user_id)
    emitMemberUpserted(db, conversationId, membersRepo.mapMember(row), user ? usersRepo.mapUser(user) : undefined)
  }
  return added.map(membersRepo.mapMember)
}

export function removeMember(
  db: DB,
  conversationId: string,
  actorId: string,
  targetUserId: string,
): void {
  const recipients = withTx(db, () => {
    const target = membersRepo.findActive(db, conversationId, targetUserId)
    if (!target) throw err.notFound('该成员不在会话中')

    const isSelf = actorId === targetUserId
    const actor = assertMember(db, conversationId, actorId)
    if (!isSelf) {
      assertPermission(db, conversationId, actorId, Permission.MANAGE_MEMBERS)
      assertOutranks(actor, target)
    } else if (target.role === Role.Owner) {
      throw err.forbidden('群主不能直接退出，请先转让群主')
    }

    membersRepo.markLeft(db, conversationId, targetUserId)
    writeChange(db, {
      entity: 'member',
      entityId: targetUserId,
      op: 'delete',
      conversationId,
      payload: { conversationId, userId: targetUserId },
      actorId,
    })

    return membersRepo.listActive(db, conversationId).map((m) => m.user_id)
  })

  emitMemberRemoved(db, conversationId, targetUserId, recipients)
}

export function setPin(db: DB, conversationId: string, userId: string, pinned: boolean): Member {
  const member = withTx(db, () => {
    assertMember(db, conversationId, userId)
    const row = membersRepo.update(db, conversationId, userId, { pinnedAt: pinned ? now() : null })
    writeChange(db, {
      entity: 'member',
      entityId: userId,
      op: 'upsert',
      conversationId,
      payload: membersRepo.mapMember(row),
      actorId: userId,
    })
    return row
  })
  return membersRepo.mapMember(member)
}

export function updateMember(
  db: DB,
  conversationId: string,
  actorId: string,
  targetUserId: string,
  patch: membersRepo.UpdateMemberInput,
): Member {
  const row = withTx(db, () => {
    const target = membersRepo.findActive(db, conversationId, targetUserId)
    if (!target) throw err.notFound('该成员不在会话中')

    if (patch.role !== undefined && usersRepo.findById(db, targetUserId)?.is_bot === 1) {
      throw err.forbidden('AI 角色不能担任管理员')
    }

    const actor = assertMember(db, conversationId, actorId)
    if (actorId !== targetUserId) {
      assertPermission(db, conversationId, actorId, Permission.MANAGE_MEMBERS)
      assertOutranks(actor, target)
    } else if (patch.role !== undefined) {
      throw err.forbidden('不能修改自己的角色')
    }

    const updated = membersRepo.update(db, conversationId, targetUserId, patch)
    writeChange(db, {
      entity: 'member',
      entityId: targetUserId,
      op: 'upsert',
      conversationId,
      payload: membersRepo.mapMember(updated),
      actorId,
    })
    return updated
  })

  emitMemberUpserted(db, conversationId, membersRepo.mapMember(row))
  return membersRepo.mapMember(row)
}

/** 转让群主：原群主降为管理员，目标必须是群里的真人成员 */
export function transferOwner(
  db: DB,
  conversationId: string,
  actorId: string,
  targetUserId: string,
): { previous: Member; next: Member } {
  const result = withTx(db, () => {
    const actor = assertMember(db, conversationId, actorId)
    if (actor.role !== Role.Owner) throw err.forbidden('只有群主可以转让群主')

    const target = membersRepo.findActive(db, conversationId, targetUserId)
    if (!target) throw err.notFound('该成员不在会话中')
    if (targetUserId === actorId) throw err.validation('你已经是群主了')
    if (usersRepo.findById(db, targetUserId)?.is_bot === 1) {
      throw err.forbidden('AI 角色不能当群主')
    }

    const previous = membersRepo.update(db, conversationId, actorId, { role: Role.Admin })
    const next = membersRepo.update(db, conversationId, targetUserId, { role: Role.Owner })

    for (const row of [previous, next]) {
      writeChange(db, {
        entity: 'member',
        entityId: row.user_id,
        op: 'upsert',
        conversationId,
        payload: membersRepo.mapMember(row),
        actorId,
      })
    }
    return { previous, next }
  })

  emitMemberUpserted(db, conversationId, membersRepo.mapMember(result.previous))
  emitMemberUpserted(db, conversationId, membersRepo.mapMember(result.next))
  return { previous: membersRepo.mapMember(result.previous), next: membersRepo.mapMember(result.next) }
}

/** 解散群：软删除会话，成员与历史消息保留在库里便于审计 */
export function dissolveGroup(db: DB, conversationId: string, actorId: string): void {
  const conversation = withTx(db, () => {
    const actor = assertMember(db, conversationId, actorId)
    if (actor.role !== Role.Owner) throw err.forbidden('只有群主可以解散群')

    const row = conversationsRepo.findById(db, conversationId)
    if (!row || row.type !== ConversationType.Group || row.deleted_at !== null) {
      throw err.notFound('群聊不存在')
    }

    conversationsRepo.softDelete(db, conversationId)
    const next = conversationsRepo.findById(db, conversationId)
    if (!next) throw err.notFound('群聊不存在')
    const mapped = conversationsRepo.mapConversation(next)
    writeChange(db, {
      entity: 'conversation',
      entityId: conversationId,
      op: 'delete',
      conversationId,
      payload: mapped,
      actorId,
    })
    return mapped
  })

  emitConversationUpdated(db, conversation)
}
