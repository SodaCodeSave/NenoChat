import {
  ContactRelation,
  type Contact,
  type PublicUser,
} from '@nenochat/shared'
import type { DB } from '../db'
import { withTx } from '../db/tx'
import * as contactsRepo from '../db/repo/contacts'
import * as usersRepo from '../db/repo/users'
import * as aiRepo from '../db/repo/ai'
import * as conversationsRepo from '../db/repo/conversations'
import * as conversationService from './conversation-service'
import type { ConversationCleanup } from './conversation-service'
import { writeChange } from './change-log'
import { err } from '../util/errors'
import { emitContactUpdated } from '../ws/emitter'

function mapContact(row: contactsRepo.ContactRow, user: PublicUser | null): Contact {
  return {
    ownerId: row.owner_id,
    contactUserId: row.contact_user_id,
    alias: row.alias,
    relation: row.relation as Contact['relation'],
    requestMessage: row.request_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    user: user ?? undefined,
  }
}

async function publicUserOf(db: DB, userId: string): Promise<PublicUser | null> {
  const row = await usersRepo.findById(db, userId)
  return row ? usersRepo.mapPublicUser(row) : null
}

export interface ContactListView {
  friends: Contact[]
  incoming: Contact[]
  outgoing: Contact[]
}

/** 通讯录统一列表：真人与 AI 角色都在这里，不按来源分组 */
export async function list(db: DB, ownerId: string): Promise<ContactListView> {
  const rows = await contactsRepo.list(db, ownerId)
  const userRows = await usersRepo.listByIds(
    db,
    rows.map((row) => row.contact_user_id),
  )
  const users = new Map(userRows.map((user) => [user.id, usersRepo.mapPublicUser(user)]))

  const mapped = rows
    .filter((row) => users.has(row.contact_user_id))
    .map((row) => mapContact(row, users.get(row.contact_user_id) ?? null))

  const byName = (a: Contact, b: Contact): number =>
    (a.alias ?? a.user?.displayName ?? '').localeCompare(b.alias ?? b.user?.displayName ?? '', 'zh-CN')

  return {
    friends: mapped.filter((item) => item.relation === ContactRelation.Friend).sort(byName),
    incoming: mapped.filter((item) => item.relation === ContactRelation.PendingIn),
    outgoing: mapped.filter((item) => item.relation === ContactRelation.PendingOut),
  }
}

async function writeContactChange(
  db: DB,
  ownerId: string,
  row: contactsRepo.ContactRow | null,
  contactUserId: string,
  op: 'upsert' | 'delete',
  actorId: string,
): Promise<Contact> {
  const payload =
    op === 'delete' || !row
      ? { ownerId, contactUserId }
      : mapContact(row, await publicUserOf(db, contactUserId))
  await writeChange(db, {
    entity: 'contact',
    entityId: `${ownerId}:${contactUserId}`,
    op,
    userId: ownerId,
    payload,
    actorId,
  })
  return payload as Contact
}

/** 双方直接成为好友：用于接受申请、主人的 AI 角色进通讯录 */
async function linkFriends(db: DB, a: string, b: string, actorId: string): Promise<{ mine: Contact; theirs: Contact }> {
  const mine = await contactsRepo.upsert(db, {
    ownerId: a,
    contactUserId: b,
    relation: ContactRelation.Friend,
  })
  const theirs = await contactsRepo.upsert(db, {
    ownerId: b,
    contactUserId: a,
    relation: ContactRelation.Friend,
  })
  return {
    mine: await writeContactChange(db, a, mine, b, 'upsert', actorId),
    theirs: await writeContactChange(db, b, theirs, a, 'upsert', actorId),
  }
}

/** 把自己的 AI 角色放进通讯录（角色创建时也会调用） */
export async function addOwnPersona(db: DB, ownerId: string, personaId: string): Promise<Contact> {
  const persona = await aiRepo.findPersona(db, personaId)
  if (!persona || persona.owner_id !== ownerId) throw err.notFound('角色不存在')
  if (!persona.user_id) throw err.validation('该角色还没有绑定账号')

  const result = await withTx(db, async (tx) => {
    const linked = await linkFriends(tx, ownerId, persona.user_id!, ownerId)
    await aiRepo.updatePersona(tx, persona.id, { inContacts: true })
    return linked.mine
  })

  await emitContactUpdated(ownerId, result)
  return result
}

export async function sendRequest(
  db: DB,
  ownerId: string,
  targetUserId: string,
  message?: string,
): Promise<Contact> {
  if (ownerId === targetUserId) throw err.validation('不能添加自己')

  const target = await usersRepo.findById(db, targetUserId)
  if (!target) throw err.notFound('用户不存在')

  // 自己的 AI 角色不需要申请，直接进通讯录
  if (target.is_bot === 1) {
    const persona = await aiRepo.findPersonaByUserId(db, targetUserId)
    if (!persona || persona.owner_id !== ownerId) {
      throw err.forbidden('只能添加自己的 AI 角色')
    }
    return addOwnPersona(db, ownerId, persona.id)
  }

  const mine = await contactsRepo.find(db, ownerId, targetUserId)
  if (mine?.relation === ContactRelation.Friend) throw err.validation('你们已经是好友')
  if (mine?.relation === ContactRelation.Blocked) throw err.forbidden('你已拉黑对方')

  // 对方已经申请过：直接视为同意，省一次往返
  const theirs = await contactsRepo.find(db, targetUserId, ownerId)
  if (theirs?.relation === ContactRelation.PendingOut) {
    return (await accept(db, ownerId, targetUserId)).contact
  }

  const result = await withTx(db, async (tx) => {
    const outgoing = await contactsRepo.upsert(tx, {
      ownerId,
      contactUserId: targetUserId,
      relation: ContactRelation.PendingOut,
      requestMessage: message ?? null,
    })
    const incoming = await contactsRepo.upsert(tx, {
      ownerId: targetUserId,
      contactUserId: ownerId,
      relation: ContactRelation.PendingIn,
      requestMessage: message ?? null,
    })
    await writeContactChange(tx, ownerId, outgoing, targetUserId, 'upsert', ownerId)
    await writeContactChange(tx, targetUserId, incoming, ownerId, 'upsert', ownerId)
    return outgoing
  })

  const contact = mapContact(result, await publicUserOf(db, targetUserId))
  await emitContactUpdated(ownerId, contact)
  const counterpart = await contactsRepo.find(db, targetUserId, ownerId)
  await emitContactUpdated(
    targetUserId,
    mapContact(counterpart!, await publicUserOf(db, ownerId)),
  )
  return contact
}

export async function accept(
  db: DB,
  ownerId: string,
  requesterId: string,
): Promise<{ contact: Contact; requester: Contact }> {
  const incoming = await contactsRepo.find(db, ownerId, requesterId)
  if (!incoming || incoming.relation !== ContactRelation.PendingIn) {
    throw err.notFound('没有待处理的好友申请')
  }

  const result = await withTx(db, async (tx) => linkFriends(tx, ownerId, requesterId, ownerId))

  await emitContactUpdated(ownerId, result.mine)
  await emitContactUpdated(requesterId, result.theirs)
  return { contact: result.mine, requester: result.theirs }
}

export async function decline(db: DB, ownerId: string, requesterId: string): Promise<void> {
  const incoming = await contactsRepo.find(db, ownerId, requesterId)
  if (!incoming || incoming.relation !== ContactRelation.PendingIn) {
    throw err.notFound('没有待处理的好友申请')
  }

  await withTx(db, async (tx) => {
    await contactsRepo.removePair(tx, ownerId, requesterId)
    await writeContactChange(tx, ownerId, null, requesterId, 'delete', ownerId)
    await writeContactChange(tx, requesterId, null, ownerId, 'delete', ownerId)
  })

  await emitContactUpdated(ownerId, { ownerId, contactUserId: requesterId } as Contact)
  await emitContactUpdated(requesterId, { ownerId: requesterId, contactUserId: ownerId } as Contact)
}

export async function removeFriend(db: DB, ownerId: string, contactUserId: string): Promise<void> {
  const mine = await contactsRepo.find(db, ownerId, contactUserId)
  if (!mine) throw err.notFound('联系人不存在')

  const cleanups: ConversationCleanup[] = []

  await withTx(db, async (tx) => {
    await contactsRepo.removePair(tx, ownerId, contactUserId)
    await writeContactChange(tx, ownerId, null, contactUserId, 'delete', ownerId)
    await writeContactChange(tx, contactUserId, null, ownerId, 'delete', ownerId)

    const direct = await conversationsRepo.findActiveDirectWithUser(tx, ownerId, contactUserId)
    if (direct) {
      const cleanup = await conversationService.cleanupForUser(tx, direct.id, ownerId)
      if (cleanup) cleanups.push(cleanup)
    }

    const persona = await aiRepo.findPersonaByUserId(tx, contactUserId)
    if (persona && persona.owner_id === ownerId) {
      await aiRepo.updatePersona(tx, persona.id, { inContacts: false })
      const aiConversation = await conversationsRepo.findAiByOwnerAndPersona(tx, ownerId, persona.id)
      if (aiConversation) {
        const cleanup = await conversationService.cleanupForUser(tx, aiConversation.id, ownerId)
        if (cleanup) cleanups.push(cleanup)
      }
    }
  })

  for (const cleanup of cleanups) {
    await conversationService.emitConversationCleanup(db, cleanup)
  }
  await emitContactUpdated(ownerId, { ownerId, contactUserId } as Contact)
  await emitContactUpdated(contactUserId, { ownerId: contactUserId, contactUserId: ownerId } as Contact)
}

export async function setAlias(db: DB, ownerId: string, contactUserId: string, alias: string | null): Promise<Contact> {
  const current = await contactsRepo.find(db, ownerId, contactUserId)
  if (!current) throw err.notFound('联系人不存在')

  const row = await withTx(db, async (tx) => {
    const next = await contactsRepo.upsert(tx, {
      ownerId,
      contactUserId,
      relation: current.relation as Contact['relation'],
      alias: alias && alias.length > 0 ? alias : null,
      requestMessage: current.request_message,
    })
    await writeContactChange(tx, ownerId, next, contactUserId, 'upsert', ownerId)
    return next
  })

  const contact = mapContact(row, await publicUserOf(db, contactUserId))
  await emitContactUpdated(ownerId, contact)
  return contact
}
