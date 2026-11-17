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

function publicUserOf(db: DB, userId: string): PublicUser | null {
  const row = usersRepo.findById(db, userId)
  return row ? usersRepo.mapPublicUser(row) : null
}

export interface ContactListView {
  friends: Contact[]
  incoming: Contact[]
  outgoing: Contact[]
}

/** 通讯录统一列表：真人与 AI 角色都在这里，不按来源分组 */
export function list(db: DB, ownerId: string): ContactListView {
  const rows = contactsRepo.list(db, ownerId)
  const users = new Map(
    usersRepo
      .listByIds(
        db,
        rows.map((row) => row.contact_user_id),
      )
      .map((user) => [user.id, usersRepo.mapPublicUser(user)]),
  )

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

function writeContactChange(
  db: DB,
  ownerId: string,
  row: contactsRepo.ContactRow | null,
  contactUserId: string,
  op: 'upsert' | 'delete',
  actorId: string,
): Contact {
  const payload =
    op === 'delete' || !row
      ? { ownerId, contactUserId }
      : mapContact(row, publicUserOf(db, contactUserId))
  writeChange(db, {
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
function linkFriends(db: DB, a: string, b: string, actorId: string): { mine: Contact; theirs: Contact } {
  const mine = contactsRepo.upsert(db, {
    ownerId: a,
    contactUserId: b,
    relation: ContactRelation.Friend,
  })
  const theirs = contactsRepo.upsert(db, {
    ownerId: b,
    contactUserId: a,
    relation: ContactRelation.Friend,
  })
  return {
    mine: writeContactChange(db, a, mine, b, 'upsert', actorId),
    theirs: writeContactChange(db, b, theirs, a, 'upsert', actorId),
  }
}

/** 把自己的 AI 角色放进通讯录（角色创建时也会调用） */
export function addOwnPersona(db: DB, ownerId: string, personaId: string): Contact {
  const persona = aiRepo.findPersona(db, personaId)
  if (!persona || persona.owner_id !== ownerId) throw err.notFound('角色不存在')
  if (!persona.user_id) throw err.validation('该角色还没有绑定账号')

  const result = withTx(db, () => {
    const linked = linkFriends(db, ownerId, persona.user_id!, ownerId)
    aiRepo.updatePersona(db, persona.id, { inContacts: true })
    return linked.mine
  })

  emitContactUpdated(ownerId, result)
  return result
}

export function sendRequest(
  db: DB,
  ownerId: string,
  targetUserId: string,
  message?: string,
): Contact {
  if (ownerId === targetUserId) throw err.validation('不能添加自己')

  const target = usersRepo.findById(db, targetUserId)
  if (!target) throw err.notFound('用户不存在')

  // 自己的 AI 角色不需要申请，直接进通讯录
  if (target.is_bot === 1) {
    const persona = aiRepo.findPersonaByUserId(db, targetUserId)
    if (!persona || persona.owner_id !== ownerId) {
      throw err.forbidden('只能添加自己的 AI 角色')
    }
    return addOwnPersona(db, ownerId, persona.id)
  }

  const mine = contactsRepo.find(db, ownerId, targetUserId)
  if (mine?.relation === ContactRelation.Friend) throw err.validation('你们已经是好友')
  if (mine?.relation === ContactRelation.Blocked) throw err.forbidden('你已拉黑对方')

  // 对方已经申请过：直接视为同意，省一次往返
  const theirs = contactsRepo.find(db, targetUserId, ownerId)
  if (theirs?.relation === ContactRelation.PendingOut) {
    return accept(db, ownerId, targetUserId).contact
  }

  const result = withTx(db, () => {
    const outgoing = contactsRepo.upsert(db, {
      ownerId,
      contactUserId: targetUserId,
      relation: ContactRelation.PendingOut,
      requestMessage: message ?? null,
    })
    const incoming = contactsRepo.upsert(db, {
      ownerId: targetUserId,
      contactUserId: ownerId,
      relation: ContactRelation.PendingIn,
      requestMessage: message ?? null,
    })
    writeContactChange(db, ownerId, outgoing, targetUserId, 'upsert', ownerId)
    writeContactChange(db, targetUserId, incoming, ownerId, 'upsert', ownerId)
    return outgoing
  })

  const contact = mapContact(result, publicUserOf(db, targetUserId))
  emitContactUpdated(ownerId, contact)
  emitContactUpdated(targetUserId, mapContact(contactsRepo.find(db, targetUserId, ownerId)!, publicUserOf(db, ownerId)))
  return contact
}

export function accept(
  db: DB,
  ownerId: string,
  requesterId: string,
): { contact: Contact; requester: Contact } {
  const incoming = contactsRepo.find(db, ownerId, requesterId)
  if (!incoming || incoming.relation !== ContactRelation.PendingIn) {
    throw err.notFound('没有待处理的好友申请')
  }

  const result = withTx(db, () => linkFriends(db, ownerId, requesterId, ownerId))

  emitContactUpdated(ownerId, result.mine)
  emitContactUpdated(requesterId, result.theirs)
  return { contact: result.mine, requester: result.theirs }
}

export function decline(db: DB, ownerId: string, requesterId: string): void {
  const incoming = contactsRepo.find(db, ownerId, requesterId)
  if (!incoming || incoming.relation !== ContactRelation.PendingIn) {
    throw err.notFound('没有待处理的好友申请')
  }

  withTx(db, () => {
    contactsRepo.removePair(db, ownerId, requesterId)
    writeContactChange(db, ownerId, null, requesterId, 'delete', ownerId)
    writeContactChange(db, requesterId, null, ownerId, 'delete', ownerId)
  })

  emitContactUpdated(ownerId, { ownerId, contactUserId: requesterId } as Contact)
  emitContactUpdated(requesterId, { ownerId: requesterId, contactUserId: ownerId } as Contact)
}

export function removeFriend(db: DB, ownerId: string, contactUserId: string): void {
  const mine = contactsRepo.find(db, ownerId, contactUserId)
  if (!mine) throw err.notFound('联系人不存在')

  withTx(db, () => {
    contactsRepo.removePair(db, ownerId, contactUserId)
    writeContactChange(db, ownerId, null, contactUserId, 'delete', ownerId)
    writeContactChange(db, contactUserId, null, ownerId, 'delete', ownerId)

    // 从通讯录移除自己的 AI 角色：会话保留，主动消息也跟着停
    const persona = aiRepo.findPersonaByUserId(db, contactUserId)
    if (persona && persona.owner_id === ownerId) {
      aiRepo.updatePersona(db, persona.id, { inContacts: false })
    }
  })

  emitContactUpdated(ownerId, { ownerId, contactUserId } as Contact)
  emitContactUpdated(contactUserId, { ownerId: contactUserId, contactUserId: ownerId } as Contact)
}

export function setAlias(db: DB, ownerId: string, contactUserId: string, alias: string | null): Contact {
  const current = contactsRepo.find(db, ownerId, contactUserId)
  if (!current) throw err.notFound('联系人不存在')

  const row = withTx(db, () => {
    const next = contactsRepo.upsert(db, {
      ownerId,
      contactUserId,
      relation: current.relation as Contact['relation'],
      alias: alias && alias.length > 0 ? alias : null,
      requestMessage: current.request_message,
    })
    writeContactChange(db, ownerId, next, contactUserId, 'upsert', ownerId)
    return next
  })

  const contact = mapContact(row, publicUserOf(db, contactUserId))
  emitContactUpdated(ownerId, contact)
  return contact
}
