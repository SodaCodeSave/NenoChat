import {
  ConversationType,
  Permission,
  Role,
  dmKey,
  ulid,
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

export async function list(db: DB, userId: string): Promise<ConversationSummary[]> {
  const rows = await conversationsRepo.listForUser(db, userId)
  return rows.map((row) => ({
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

export async function detail(db: DB, conversationId: string, userId: string): Promise<DetailResult> {
  const member = await assertMember(db, conversationId, userId)
  const conv = await conversationsRepo.findById(db, conversationId)
  if (!conv || conv.deleted_at !== null) throw err.notFound('会话不存在')

  const memberRows = await membersRepo.listActive(db, conversationId)
  const userRows = await usersRepo.listByIds(
    db,
    memberRows.map((m) => m.user_id),
  )
  const userMap = new Map(userRows.map((u) => [u.id, u]))

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
export async function openDirect(db: DB, userId: string, targetUserId: string): Promise<Conversation> {
  if (userId === targetUserId) throw err.validation('不能和自己创建私聊')

  const target = await usersRepo.findById(db, targetUserId)
  if (!target) throw err.notFound('用户不存在')

  const active = await conversationsRepo.findActiveDirectWithUser(db, userId, targetUserId)
  if (active) return conversationsRepo.mapConversation(active)

  const baseKey = dmKey(userId, targetUserId)
  const existing = await conversationsRepo.findByDmKey(db, baseKey)

  const conv = await withTx(db, async (tx) => {
    const row = await conversationsRepo.create(tx, {
      type: ConversationType.Direct,
      name: null,
      ownerId: userId,
      dmKey: existing ? `${baseKey}:${ulid()}` : baseKey,
    })
    await membersRepo.upsert(tx, { conversationId: row.id, userId, role: Role.Owner })
    await membersRepo.upsert(tx, { conversationId: row.id, userId: targetUserId, role: Role.Member })

    const mapped = conversationsRepo.mapConversation(row)
    await writeChange(tx, {
      entity: 'conversation',
      entityId: row.id,
      op: 'upsert',
      conversationId: row.id,
      payload: mapped,
      actorId: userId,
    })
    return mapped
  })

  await emitConversationUpdated(db, conv)
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
async function assertAddableUsers(db: DB, actorId: string, userIds: string[]): Promise<void> {
  for (const id of Array.from(new Set(userIds))) {
    const user = await usersRepo.findById(db, id)
    if (!user) throw err.notFound('用户不存在')

    if (user.is_bot === 1) {
      const persona = await aiRepo.findPersonaByUserId(db, id)
      if (!persona || persona.owner_id !== actorId) {
        throw err.forbidden('只能把自己的 AI 角色拉进群')
      }
    }
  }
}

export async function createGroup(db: DB, userId: string, input: CreateGroupInput): Promise<DetailResult> {
  const members = Array.from(new Set([userId, ...(input.memberIds ?? [])]))
  await assertAddableUsers(db, userId, members)

  const conversationId = await withTx(db, async (tx) => {
    const row = await conversationsRepo.create(tx, {
      type: ConversationType.Group,
      name: input.name,
      avatarUrl: input.avatarUrl ?? null,
      ownerId: userId,
    })

    for (const memberId of members) {
      await membersRepo.upsert(tx, {
        conversationId: row.id,
        userId: memberId,
        role: memberId === userId ? Role.Owner : Role.Member,
        invitedBy: userId,
      })
    }

    const mapped = conversationsRepo.mapConversation(row)
    await writeChange(tx, {
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

export async function update(
  db: DB,
  conversationId: string,
  userId: string,
  patch: UpdateConversationInput,
): Promise<Conversation> {
  const conv = await withTx(db, async (tx) => {
    // 改公告需要单独的管理权限，改名/头像同样走会话管理权限
    await assertPermission(tx, conversationId, userId, Permission.MANAGE_CONVERSATION)

    const row = await conversationsRepo.update(tx, conversationId, {
      ...patch,
      announcementUpdatedBy: patch.announcement !== undefined ? userId : undefined,
    })
    const mapped = conversationsRepo.mapConversation(row)
    await writeChange(tx, {
      entity: 'conversation',
      entityId: row.id,
      op: 'upsert',
      conversationId: row.id,
      payload: mapped,
      actorId: userId,
    })
    return mapped
  })

  await emitConversationUpdated(db, conv)
  return conv
}

export async function addMembers(db: DB, conversationId: string, actorId: string, userIds: string[]): Promise<Member[]> {
  await assertPermission(db, conversationId, actorId, Permission.MANAGE_MEMBERS)
  await assertAddableUsers(db, actorId, userIds)

  const added = await withTx(db, async (tx) => {
    const result: membersRepo.MemberRow[] = []
    for (const userId of Array.from(new Set(userIds))) {
      if (!(await usersRepo.findById(tx, userId))) continue
      if (await membersRepo.findActive(tx, conversationId, userId)) continue
      const row = await membersRepo.upsert(tx, { conversationId, userId, invitedBy: actorId })
      await writeChange(tx, {
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
    const user = await usersRepo.findById(db, row.user_id)
    await emitMemberUpserted(db, conversationId, membersRepo.mapMember(row), user ? usersRepo.mapUser(user) : undefined)
  }
  return added.map(membersRepo.mapMember)
}

export async function removeMember(
  db: DB,
  conversationId: string,
  actorId: string,
  targetUserId: string,
): Promise<void> {
  const recipients = await withTx(db, async (tx) => {
    const target = await membersRepo.findActive(tx, conversationId, targetUserId)
    if (!target) throw err.notFound('该成员不在会话中')

    const isSelf = actorId === targetUserId
    const actor = await assertMember(tx, conversationId, actorId)
    if (!isSelf) {
      await assertPermission(tx, conversationId, actorId, Permission.MANAGE_MEMBERS)
      assertOutranks(actor, target)
    } else if (target.role === Role.Owner) {
      throw err.forbidden('群主不能直接退出，请先转让群主')
    }

    await membersRepo.markLeft(tx, conversationId, targetUserId)
    await writeChange(tx, {
      entity: 'member',
      entityId: targetUserId,
      op: 'delete',
      conversationId,
      payload: { conversationId, userId: targetUserId },
      actorId,
    })

    const rows = await membersRepo.listActive(tx, conversationId)
    return rows.map((m) => m.user_id)
  })

  await emitMemberRemoved(db, conversationId, targetUserId, recipients)
}

export interface ConversationCleanup {
  conversationId: string
  type: ConversationType
  actorId: string
}

/** 只清当前用户这一侧的私聊：退出真人私聊，彻底删除自己的 AI 会话 */
export async function cleanupForUser(
  db: DB,
  conversationId: string,
  actorId: string,
): Promise<ConversationCleanup | null> {
  const conversation = await conversationsRepo.findById(db, conversationId)
  if (!conversation || conversation.deleted_at !== null) return null
  if (conversation.type !== ConversationType.Direct && conversation.type !== ConversationType.Ai) {
    throw err.forbidden('只能删除私聊会话')
  }
  if (!(await membersRepo.findActive(db, conversationId, actorId))) return null

  if (conversation.type === ConversationType.Ai) {
    await conversationsRepo.hardDelete(db, conversationId)
  } else {
    await writeChange(db, {
      entity: 'member',
      entityId: actorId,
      op: 'delete',
      conversationId,
      payload: { conversationId, userId: actorId },
      actorId,
    })
    await membersRepo.markLeft(db, conversationId, actorId)
  }

  await writeChange(db, {
    entity: 'conversation',
    entityId: conversationId,
    op: 'delete',
    payload: { id: conversationId },
    actorId,
    userId: actorId,
  })

  return { conversationId, type: conversation.type, actorId }
}

/** 清理完成后的广播：真人私聊通知对端成员变化，AI 会话没有第二方 */
export async function emitConversationCleanup(db: DB, cleanup: ConversationCleanup): Promise<void> {
  if (cleanup.type === ConversationType.Direct) {
    await emitMemberRemoved(db, cleanup.conversationId, cleanup.actorId)
  }
}

export async function deleteConversationForUser(db: DB, conversationId: string, actorId: string): Promise<void> {
  const cleanup = await withTx(db, async (tx) => cleanupForUser(tx, conversationId, actorId))
  if (cleanup) await emitConversationCleanup(db, cleanup)
}

export async function setPin(db: DB, conversationId: string, userId: string, pinned: boolean): Promise<Member> {
  const member = await withTx(db, async (tx) => {
    await assertMember(tx, conversationId, userId)
    const row = await membersRepo.update(tx, conversationId, userId, { pinnedAt: pinned ? now() : null })
    await writeChange(tx, {
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

export async function updateMember(
  db: DB,
  conversationId: string,
  actorId: string,
  targetUserId: string,
  patch: membersRepo.UpdateMemberInput,
): Promise<Member> {
  const row = await withTx(db, async (tx) => {
    const target = await membersRepo.findActive(tx, conversationId, targetUserId)
    if (!target) throw err.notFound('该成员不在会话中')

    if (patch.role !== undefined && (await usersRepo.findById(tx, targetUserId))?.is_bot === 1) {
      throw err.forbidden('AI 角色不能担任管理员')
    }

    const actor = await assertMember(tx, conversationId, actorId)
    if (actorId !== targetUserId) {
      await assertPermission(tx, conversationId, actorId, Permission.MANAGE_MEMBERS)
      assertOutranks(actor, target)
    } else if (patch.role !== undefined) {
      throw err.forbidden('不能修改自己的角色')
    }

    const updated = await membersRepo.update(tx, conversationId, targetUserId, patch)
    await writeChange(tx, {
      entity: 'member',
      entityId: targetUserId,
      op: 'upsert',
      conversationId,
      payload: membersRepo.mapMember(updated),
      actorId,
    })
    return updated
  })

  await emitMemberUpserted(db, conversationId, membersRepo.mapMember(row))
  return membersRepo.mapMember(row)
}

/** 转让群主：原群主降为管理员，目标必须是群里的真人成员 */
export async function transferOwner(
  db: DB,
  conversationId: string,
  actorId: string,
  targetUserId: string,
): Promise<{ previous: Member; next: Member }> {
  const result = await withTx(db, async (tx) => {
    const actor = await assertMember(tx, conversationId, actorId)
    if (actor.role !== Role.Owner) throw err.forbidden('只有群主可以转让群主')

    const target = await membersRepo.findActive(tx, conversationId, targetUserId)
    if (!target) throw err.notFound('该成员不在会话中')
    if (targetUserId === actorId) throw err.validation('你已经是群主了')
    if ((await usersRepo.findById(tx, targetUserId))?.is_bot === 1) {
      throw err.forbidden('AI 角色不能当群主')
    }

    const previous = await membersRepo.update(tx, conversationId, actorId, { role: Role.Admin })
    const next = await membersRepo.update(tx, conversationId, targetUserId, { role: Role.Owner })

    for (const row of [previous, next]) {
      await writeChange(tx, {
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

  await emitMemberUpserted(db, conversationId, membersRepo.mapMember(result.previous))
  await emitMemberUpserted(db, conversationId, membersRepo.mapMember(result.next))
  return { previous: membersRepo.mapMember(result.previous), next: membersRepo.mapMember(result.next) }
}

/** 解散群：软删除会话，成员与历史消息保留在库里便于审计 */
export async function dissolveGroup(db: DB, conversationId: string, actorId: string): Promise<void> {
  const conversation = await withTx(db, async (tx) => {
    const actor = await assertMember(tx, conversationId, actorId)
    if (actor.role !== Role.Owner) throw err.forbidden('只有群主可以解散群')

    const row = await conversationsRepo.findById(tx, conversationId)
    if (!row || row.type !== ConversationType.Group || row.deleted_at !== null) {
      throw err.notFound('群聊不存在')
    }

    await conversationsRepo.softDelete(tx, conversationId)
    const next = await conversationsRepo.findById(tx, conversationId)
    if (!next) throw err.notFound('群聊不存在')
    const mapped = conversationsRepo.mapConversation(next)
    await writeChange(tx, {
      entity: 'conversation',
      entityId: conversationId,
      op: 'delete',
      conversationId,
      payload: mapped,
      actorId,
    })
    return mapped
  })

  await emitConversationUpdated(db, conversation)
}
