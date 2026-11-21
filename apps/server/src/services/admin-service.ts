import type { Conversation, Device, Message, User } from '@nenochat/shared'
import type { DB } from '../db'
import { all, one, run } from '../db'
import { withTx } from '../db/tx'
import { now } from '../util/clock'
import { err } from '../util/errors'
import { hashPassword, randomToken } from '../util/crypto'
import * as usersRepo from '../db/repo/users'
import * as devicesRepo from '../db/repo/devices'
import * as tokensRepo from '../db/repo/refresh-tokens'
import * as messagesRepo from '../db/repo/messages'
import * as conversationsRepo from '../db/repo/conversations'
import * as postsRepo from '../db/repo/posts'
import * as attachmentsRepo from '../db/repo/attachments'
import * as adminAuditRepo from '../db/repo/admin-audit'
import * as authService from './auth-service'
import { writeChange } from './change-log'
import { hub } from '../ws/hub'
import { emitMessageUpdated, emitPostRemoved, emitPostUpdated } from '../ws/emitter'
import { reclaimAttachments, type AttachmentGcResult } from './attachment-gc'

/**
 * 管理面板服务层。
 *
 * 管理操作与用户侧同名操作的关键差异：绕过会话成员/所有权检查，
 * 但保留同步变更（writeChange）与 WS 广播，普通客户端无需感知「这是管理员干的」。
 * 所有写操作在路由层配套写审计日志。
 */

export const PAGE_SIZE = 20

function pageOffset(page: number): number {
  return (Math.max(1, page) - 1) * PAGE_SIZE
}

/* ------------------------------ 统计 ------------------------------ */

export interface AdminStats {
  users: { total: number; disabled: number; bots: number; active24h: number }
  conversations: { total: number; direct: number; group: number; ai: number }
  messages: { total: number; last24h: number }
  posts: { total: number }
  storage: { attachments: number; bytes: number }
  ai: { tokens24h: number; tokens7d: number }
  recentUsers: User[]
}

export async function getStats(db: DB): Promise<AdminStats> {
  const day = 24 * 60 * 60 * 1000
  const ts = now()

  const [userRow, disabledRow, botRow, active24hRow, msgRow, msg24hRow, postRow, attRow, ai24h, ai7d] =
    await Promise.all([
      one<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM users WHERE is_bot = 0'),
      one<{ c: number }>(db, "SELECT COUNT(*) AS c FROM users WHERE is_bot = 0 AND status = 'disabled'"),
      one<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM users WHERE is_bot = 1'),
      one<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM users WHERE is_bot = 0 AND last_seen_at >= ?', [ts - day]),
      one<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM messages WHERE deleted_at IS NULL'),
      one<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM messages WHERE deleted_at IS NULL AND created_at >= ?', [
        ts - day,
      ]),
      one<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM posts WHERE deleted_at IS NULL'),
      one<{ total: number; bytes: number }>(
        db,
        'SELECT COUNT(*) AS total, COALESCE(SUM(size), 0) AS bytes FROM attachments WHERE deleted_at IS NULL',
      ),
      one<{ t: number }>(
        db,
        'SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS t FROM ai_usage_log WHERE created_at >= ?',
        [ts - day],
      ),
      one<{ t: number }>(
        db,
        'SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS t FROM ai_usage_log WHERE created_at >= ?',
        [ts - 7 * day],
      ),
    ])

  const convRows = await all<{ type: string; c: number }>(
    db,
    'SELECT type, COUNT(*) AS c FROM conversations WHERE deleted_at IS NULL GROUP BY type',
  )
  const conversations = { total: 0, direct: 0, group: 0, ai: 0 }
  for (const row of convRows) {
    conversations.total += row.c
    if (row.type === 'direct') conversations.direct = row.c
    else if (row.type === 'group') conversations.group = row.c
    else if (row.type === 'ai') conversations.ai = row.c
  }

  const recentRows = await all<usersRepo.UserRow>(
    db,
    'SELECT * FROM users WHERE is_bot = 0 ORDER BY created_at DESC LIMIT 5',
  )

  return {
    users: {
      total: userRow?.c ?? 0,
      disabled: disabledRow?.c ?? 0,
      bots: botRow?.c ?? 0,
      active24h: active24hRow?.c ?? 0,
    },
    conversations,
    messages: { total: msgRow?.c ?? 0, last24h: msg24hRow?.c ?? 0 },
    posts: { total: postRow?.c ?? 0 },
    storage: { attachments: attRow?.total ?? 0, bytes: Number(attRow?.bytes ?? 0) },
    ai: { tokens24h: Number(ai24h?.t ?? 0), tokens7d: Number(ai7d?.t ?? 0) },
    recentUsers: recentRows.map(usersRepo.mapUser),
  }
}

/* ------------------------------ 用户 ------------------------------ */

export interface AdminUserListItem extends User {
  deviceCount: number
}

export async function listUsers(
  db: DB,
  query: { q?: string; status?: 'active' | 'disabled'; page: number },
): Promise<{ items: AdminUserListItem[]; total: number }> {
  const params: unknown[] = []
  const where: string[] = ['u.is_bot = 0']
  if (query.status) {
    where.push('u.status = ?')
    params.push(query.status)
  }
  if (query.q) {
    where.push('(u.username ILIKE ? OR u.display_name ILIKE ?)')
    const like = `%${query.q}%`
    params.push(like, like)
  }
  const whereSql = where.join(' AND ')

  const rows = await all<usersRepo.UserRow & { device_count: number }>(
    db,
    `SELECT u.*, (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id) AS device_count
       FROM users u
      WHERE ${whereSql}
      ORDER BY u.created_at DESC
      LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, pageOffset(query.page)],
  )
  const totalRow = await one<{ c: number }>(
    db,
    `SELECT COUNT(*) AS c FROM users u WHERE ${whereSql}`,
    params,
  )
  return {
    items: rows.map((row) => ({ ...usersRepo.mapUser(row), deviceCount: row.device_count })),
    total: totalRow?.c ?? 0,
  }
}

export interface AdminUserDetail {
  user: User
  devices: Device[]
  conversationCount: number
  messageCount: number
  postCount: number
  sessionCount: number
}

export async function getUserDetail(db: DB, userId: string): Promise<AdminUserDetail> {
  const row = await usersRepo.findById(db, userId)
  if (!row) throw err.notFound('用户不存在')

  const [devices, convRow, msgRow, postRow, sessionRow] = await Promise.all([
    devicesRepo.list(db, userId),
    one<{ c: number }>(
      db,
      'SELECT COUNT(*) AS c FROM conversation_members WHERE user_id = ? AND left_at IS NULL',
      [userId],
    ),
    one<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM messages WHERE sender_id = ?', [userId]),
    one<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM posts WHERE author_id = ? AND deleted_at IS NULL', [userId]),
    one<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL', [
      userId,
    ]),
  ])

  return {
    user: usersRepo.mapUser(row),
    devices: devices.map(devicesRepo.mapDevice),
    conversationCount: convRow?.c ?? 0,
    messageCount: msgRow?.c ?? 0,
    postCount: postRow?.c ?? 0,
    sessionCount: sessionRow?.c ?? 0,
  }
}

export async function setUserStatus(db: DB, userId: string, status: 'active' | 'disabled'): Promise<User> {
  const row = await usersRepo.findById(db, userId)
  if (!row || row.is_bot === 1) throw err.notFound('用户不存在')
  await run(db, 'UPDATE users SET status = ?, updated_at = ? WHERE id = ?', [status, now(), userId])
  if (status === 'disabled') {
    // 停用即全端下线：现有会话令牌全部吊销，登录入口也被 status 挡住
    await tokensRepo.revokeAllForUser(db, userId)
  }
  const updated = await usersRepo.findById(db, userId)
  if (!updated) throw err.internal('用户状态更新失败')
  return usersRepo.mapUser(updated)
}

export async function resetPassword(db: DB, userId: string, newPassword: string): Promise<void> {
  const row = await usersRepo.findById(db, userId)
  if (!row || row.is_bot === 1) throw err.notFound('用户不存在')
  const hash = await hashPassword(newPassword)
  await usersRepo.setPasswordHash(db, userId, hash)
  // 密码重置后强制全端重新登录，避免旧会话继续可用
  await tokensRepo.revokeAllForUser(db, userId)
}

export async function setIsAdmin(db: DB, userId: string, isAdmin: boolean): Promise<User> {
  const row = await usersRepo.findById(db, userId)
  if (!row || row.is_bot === 1) throw err.notFound('用户不存在')
  await run(db, 'UPDATE users SET is_admin = ?, updated_at = ? WHERE id = ?', [
    isAdmin ? 1 : 0,
    now(),
    userId,
  ])
  const updated = await usersRepo.findById(db, userId)
  if (!updated) throw err.internal('管理员状态更新失败')
  return usersRepo.mapUser(updated)
}

export interface DeleteUserResult {
  /** 同步给其他成员的软删消息（客户端据此把消息标成已删除） */
  removedMessages: Message[]
  /** 广播下架的动态 id */
  removedPostIds: string[]
  /** 因群主被删而移交了群主的会话 */
  transferredConversations: Conversation[]
}

/**
 * 删除用户并级联清理。外键已覆盖大部分关联（contacts/posts/comments/
 * members/tokens/devices/settings/providers/personas/connectors 均 CASCADE），
 * 这里只处理四个没有级联的例外：messages.sender_id、attachments.owner_id、
 * invites.created_by、conversations.owner_id（见 0001/0002 迁移）。
 *
 * 角色的影子账号（users.is_bot）保留不删：群聊里的历史发言 sender_id 仍指向它，
 * 删掉会让 FK 失败或把 AI 消息变「未知用户」，孤儿账号无登录能力，无实际风险。
 */
export async function deleteUser(db: DB, userId: string, actorId: string): Promise<DeleteUserResult> {
  const row = await usersRepo.findById(db, userId)
  if (!row) throw err.notFound('用户不存在')
  if (row.is_bot === 1) throw err.forbidden('AI 角色账号由角色管理维护，不能在这里删除')
  if (userId === actorId) throw err.forbidden('不能删除自己的账号')

  const removedMessages: Message[] = []
  const removedPostIds: string[] = []
  const transferred: Conversation[] = []

  await withTx(db, async (tx) => {
    // 1. 他发出的在屏消息软删并写同步变更，其他成员的客户端据此刻回收起
    const activeMsgs = await all<{ id: string; conversation_id: string }>(
      tx,
      'SELECT id, conversation_id FROM messages WHERE sender_id = ? AND deleted_at IS NULL',
      [userId],
    )
    for (const msg of activeMsgs) {
      const updated = await messagesRepo.softDelete(tx, msg.id, actorId, now())
      const mapped = messagesRepo.mapMessage(updated)
      removedMessages.push(mapped)
      await writeChange(tx, {
        entity: 'message',
        entityId: msg.id,
        op: 'upsert',
        conversationId: msg.conversation_id,
        payload: mapped,
        actorId,
      })
    }
    // 2. 剩余软删消息解除发送者外键（sender_id 可空、无级联）
    await run(tx, 'UPDATE messages SET sender_id = NULL WHERE sender_id = ?', [userId])

    // 3. 他名下的 AI 会话整树硬删（成员/消息/游标由外键级联清理）
    const aiConvIds = await all<{ id: string }>(
      tx,
      'SELECT id FROM conversations WHERE ai_owner_user_id = ?',
      [userId],
    )
    for (const conv of aiConvIds) {
      await conversationsRepo.hardDelete(tx, conv.id)
    }

    // 4. 群主移交：最早的活跃成员接班；只剩他一人则整群硬删
    const ownedGroups = await all<{ id: string }>(
      tx,
      `SELECT id FROM conversations
        WHERE owner_id = ? AND deleted_at IS NULL AND type = 'group'`,
      [userId],
    )
    for (const conv of ownedGroups) {
      const next = await one<{ user_id: string }>(
        tx,
        `SELECT user_id FROM conversation_members
          WHERE conversation_id = ? AND user_id <> ? AND left_at IS NULL
          ORDER BY joined_at ASC LIMIT 1`,
        [conv.id, userId],
      )
      if (!next) {
        await conversationsRepo.hardDelete(tx, conv.id)
        continue
      }
      await run(tx, 'UPDATE conversations SET owner_id = ?, updated_at = ? WHERE id = ?', [
        next.user_id,
        now(),
        conv.id,
      ])
      await run(tx, "UPDATE conversation_members SET role = 'owner' WHERE conversation_id = ? AND user_id = ?", [
        conv.id,
        next.user_id,
      ])
      const fresh = await conversationsRepo.findById(tx, conv.id)
      if (fresh) {
        const mapped = conversationsRepo.mapConversation(fresh)
        transferred.push(mapped)
        await writeChange(tx, {
          entity: 'conversation',
          entityId: conv.id,
          op: 'upsert',
          conversationId: conv.id,
          payload: mapped,
          actorId,
        })
      }
    }

    // 5. 他的评论/点赞随用户行级联删除，先把动态上的冗余计数减回去
    await run(
      tx,
      `UPDATE posts SET comment_count = GREATEST(comment_count - x.cnt, 0)
         FROM (SELECT post_id, COUNT(*) AS cnt FROM post_comments WHERE author_id = ? GROUP BY post_id) x
       WHERE posts.id = x.post_id`,
      [userId],
    )
    await run(
      tx,
      `UPDATE posts SET like_count = GREATEST(like_count - x.cnt, 0)
         FROM (SELECT post_id, COUNT(*) AS cnt FROM post_likes WHERE user_id = ? GROUP BY post_id) x
       WHERE posts.id = x.post_id`,
      [userId],
    )

    // 6. 他创建的邀请码转给执行删除的管理员（created_by 无级联且非空）
    await run(tx, 'UPDATE invites SET created_by = ? WHERE created_by = ?', [actorId, userId])
    // 7. 他上传的附件转给管理员保引用不断链（owner_id 无级联且非空）
    await run(tx, 'UPDATE attachments SET owner_id = ? WHERE owner_id = ?', [actorId, userId])

    // 8. 收集他的动态 id 供广播，随后随用户行级联删除
    const postIds = await all<{ id: string }>(tx, 'SELECT id FROM posts WHERE author_id = ?', [userId])
    removedPostIds.push(...postIds.map((p) => p.id))

    // 9. 删除用户本体，其余关联全部外键级联
    await run(tx, 'DELETE FROM users WHERE id = ?', [userId])
  })

  // 事务外广播：WS 推送失败不影响删除本身
  for (const message of removedMessages) {
    await emitMessageUpdated(db, message)
  }
  for (const postId of removedPostIds) {
    emitPostRemoved(hub().onlineUserIds(), postId)
  }
  for (const conversation of transferred) {
    hub().sendToUsers(hub().onlineUserIds(), 'conversation.updated', { conversation, me: null })
  }

  return { removedMessages, removedPostIds, transferredConversations: transferred }
}

export async function listUserDevices(db: DB, userId: string): Promise<{ devices: Device[] }> {
  const row = await usersRepo.findById(db, userId)
  if (!row) throw err.notFound('用户不存在')
  const devices = await devicesRepo.list(db, userId)
  return { devices: devices.map(devicesRepo.mapDevice) }
}

/** 管理员移除用户设备：复用用户侧「远程登出」的吊销逻辑 */
export async function removeUserDevice(db: DB, userId: string, deviceId: string): Promise<void> {
  const row = await usersRepo.findById(db, userId)
  if (!row) throw err.notFound('用户不存在')
  await authService.revokeDevice(db, userId, deviceId)
}

/* ------------------------------ 邀请码 ------------------------------ */

export interface InviteView {
  code: string
  createdBy: string | null
  createdByName: string | null
  maxUses: number
  uses: number
  expiresAt: number | null
  createdAt: number
}

interface InviteRow {
  code: string
  created_by: string
  created_by_name: string | null
  max_uses: number
  uses: number
  expires_at: number | null
  created_at: number
}

function mapInvite(row: InviteRow): InviteView {
  return {
    code: row.code,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    maxUses: row.max_uses,
    uses: row.uses,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }
}

export async function listInvites(db: DB): Promise<{ invites: InviteView[] }> {
  const rows = await all<InviteRow>(
    db,
    `SELECT i.*, u.display_name AS created_by_name
       FROM invites i LEFT JOIN users u ON u.id = i.created_by
      ORDER BY i.created_at DESC`,
  )
  return { invites: rows.map(mapInvite) }
}

export async function createInvite(
  db: DB,
  actorId: string,
  input: { maxUses: number; expiresInDays?: number | null },
): Promise<InviteView> {
  // 人类可读的短码：6 字节 base64url 足够防碰撞，长码不便口头传达
  const code = randomToken(6)
  const expiresAt =
    input.expiresInDays && input.expiresInDays > 0 ? now() + input.expiresInDays * 86_400_000 : null
  await run(
    db,
    `INSERT INTO invites (code, created_by, max_uses, uses, expires_at, created_at)
       VALUES (?, ?, ?, 0, ?, ?)`,
    [code, actorId, input.maxUses, expiresAt, now()],
  )
  const row = await one<InviteRow>(
    db,
    `SELECT i.*, u.display_name AS created_by_name
       FROM invites i LEFT JOIN users u ON u.id = i.created_by WHERE i.code = ?`,
    [code],
  )
  if (!row) throw err.internal('邀请码创建失败')
  return mapInvite(row)
}

export async function deleteInvite(db: DB, code: string): Promise<void> {
  const result = await run(db, 'DELETE FROM invites WHERE code = ?', [code])
  if (result.changes === 0) throw err.notFound('邀请码不存在')
}

/* ------------------------------ 会话与消息 ------------------------------ */

export interface AdminConversationListItem extends Conversation {
  memberCount: number
  messageCount: number
  lastActivityAt: number | null
}

export async function listConversations(
  db: DB,
  query: { type?: 'direct' | 'group' | 'ai'; q?: string; page: number },
): Promise<{ items: AdminConversationListItem[]; total: number }> {
  const params: unknown[] = []
  const where: string[] = ['c.deleted_at IS NULL']
  if (query.type) {
    where.push('c.type = ?')
    params.push(query.type)
  }
  if (query.q) {
    where.push('c.name ILIKE ?')
    params.push(`%${query.q}%`)
  }
  const whereSql = where.join(' AND ')

  const rows = await all<
    conversationsRepo.ConversationRow & { member_count: number; admin_message_count: number }
  >(
    db,
    `SELECT c.*,
            (SELECT COUNT(*) FROM conversation_members m WHERE m.conversation_id = c.id AND m.left_at IS NULL) AS member_count,
            c.message_count AS admin_message_count
       FROM conversations c
      WHERE ${whereSql}
      ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
      LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, pageOffset(query.page)],
  )
  const totalRow = await one<{ c: number }>(
    db,
    `SELECT COUNT(*) AS c FROM conversations c WHERE ${whereSql}`,
    params,
  )
  return {
    items: rows.map((row) => ({
      ...conversationsRepo.mapConversation(row),
      memberCount: row.member_count,
      messageCount: row.admin_message_count,
      lastActivityAt: row.last_message_at,
    })),
    total: totalRow?.c ?? 0,
  }
}

export interface AdminMessageListItem extends Message {
  senderName: string | null
}

export async function listConversationMessages(
  db: DB,
  conversationId: string,
  query: { beforeSeq?: number | null },
): Promise<{ items: AdminMessageListItem[]; conversation: Conversation | null }> {
  const conv = await conversationsRepo.findById(db, conversationId)
  if (!conv) throw err.notFound('会话不存在')

  const rows = await all<messagesRepo.MessageRow & { sender_name: string | null }>(
    db,
    `SELECT m.*, u.display_name AS sender_name
       FROM messages m LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.conversation_id = ? AND m.seq < ? AND m.deleted_at IS NULL
      ORDER BY m.seq DESC
      LIMIT ?`,
    [conversationId, query.beforeSeq ?? Number.MAX_SAFE_INTEGER, PAGE_SIZE],
  )
  return {
    items: rows.map((row) => ({ ...messagesRepo.mapMessage(row), senderName: row.sender_name })),
    conversation: conversationsRepo.mapConversation(conv),
  }
}

/** 管理员撤回任意消息：复用软删 + 同步变更 + WS 广播，只绕过成员/权限检查 */
export async function recallMessage(db: DB, messageId: string, actorId: string): Promise<Message> {
  const message = await withTx(db, async (tx) => {
    const row = await messagesRepo.findById(tx, messageId)
    if (!row || row.deleted_at !== null) throw err.notFound('消息不存在')

    const updated = await messagesRepo.softDelete(tx, row.id, actorId, now())
    const mapped = messagesRepo.mapMessage(updated)
    await writeChange(tx, {
      entity: 'message',
      entityId: row.id,
      op: 'upsert',
      conversationId: row.conversation_id,
      payload: mapped,
      actorId,
    })
    return mapped
  })

  await emitMessageUpdated(db, message)
  return message
}

/* ------------------------------ 动态与评论 ------------------------------ */

export interface AdminPostListItem {
  id: string
  authorId: string
  authorName: string | null
  personaId: string | null
  content: string
  visibility: string
  likeCount: number
  commentCount: number
  createdAt: number
}

export async function listPosts(
  db: DB,
  query: { q?: string; page: number },
): Promise<{ items: AdminPostListItem[]; total: number }> {
  const params: unknown[] = []
  const where: string[] = ['p.deleted_at IS NULL']
  if (query.q) {
    where.push('p.content ILIKE ?')
    params.push(`%${query.q}%`)
  }
  const whereSql = where.join(' AND ')

  const rows = await all<{
    id: string
    author_id: string
    author_name: string | null
    persona_id: string | null
    content: string
    visibility: string
    like_count: number
    comment_count: number
    created_at: number
  }>(
    db,
    `SELECT p.id, p.author_id, u.display_name AS author_name, p.persona_id, p.content,
            p.visibility, p.like_count, p.comment_count, p.created_at
       FROM posts p LEFT JOIN users u ON u.id = p.author_id
      WHERE ${whereSql}
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, pageOffset(query.page)],
  )
  const totalRow = await one<{ c: number }>(db, `SELECT COUNT(*) AS c FROM posts p WHERE ${whereSql}`, params)
  return {
    items: rows.map((row) => ({
      id: row.id,
      authorId: row.author_id,
      authorName: row.author_name,
      personaId: row.persona_id,
      content: row.content,
      visibility: row.visibility,
      likeCount: row.like_count,
      commentCount: row.comment_count,
      createdAt: row.created_at,
    })),
    total: totalRow?.c ?? 0,
  }
}

/** 管理员删动态：软删 + 全服在线广播下架 */
export async function deletePost(db: DB, postId: string): Promise<void> {
  const raw = await one<postsRepo.PostRow>(
    db,
    'SELECT * FROM posts WHERE id = ? AND deleted_at IS NULL',
    [postId],
  )
  if (!raw) throw err.notFound('动态不存在')

  await withTx(db, async (tx) => postsRepo.softDelete(tx, postId, now()))
  emitPostRemoved(hub().onlineUserIds(), postId)
}

/** 管理员删评论：软删 + 计数修正 + 评论区广播 */
export async function deleteComment(db: DB, commentId: string): Promise<{ postId: string }> {
  const comment = await postsRepo.findComment(db, commentId)
  if (!comment) throw err.notFound('评论不存在')

  await withTx(db, async (tx) => {
    await postsRepo.softDeleteComment(tx, commentId, now())
    await run(
      tx,
      'UPDATE posts SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = ? AND comment_count > 0',
      [comment.post_id],
    )
  })

  hub().sendToUsers(hub().onlineUserIds(), 'post.comment.removed', {
    postId: comment.post_id,
    commentId,
  })

  // 评论数变了，推一份最新动态快照；管理员视角加载不到（非作者）就跳过
  const post = await postsRepo.loadOne(db, comment.post_id, '')
  if (post) emitPostUpdated(hub().onlineUserIds(), post)
  return { postId: comment.post_id }
}

/* ------------------------------ 文件与存储 ------------------------------ */

export interface AdminFileListItem {
  id: string
  ownerId: string
  ownerName: string | null
  kind: string
  filename: string
  mime: string
  size: number
  sha256: string
  url: string | null
  createdAt: number
  deleted: boolean
}

export async function listFiles(
  db: DB,
  query: { kind?: string; q?: string; page: number; includeDeleted?: boolean },
): Promise<{ items: AdminFileListItem[]; total: number }> {
  const params: unknown[] = []
  const where: string[] = ['1=1']
  if (!query.includeDeleted) where.push('a.deleted_at IS NULL')
  if (query.kind) {
    where.push('a.kind = ?')
    params.push(query.kind)
  }
  if (query.q) {
    where.push('a.filename ILIKE ?')
    params.push(`%${query.q}%`)
  }
  const whereSql = where.join(' AND ')

  const rows = await all<attachmentsRepo.AttachmentRow & { owner_name: string | null }>(
    db,
    `SELECT a.*, u.display_name AS owner_name
       FROM attachments a LEFT JOIN users u ON u.id = a.owner_id
      WHERE ${whereSql}
      ORDER BY a.created_at DESC
      LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, pageOffset(query.page)],
  )
  const totalRow = await one<{ c: number }>(
    db,
    `SELECT COUNT(*) AS c FROM attachments a WHERE ${whereSql}`,
    params,
  )
  return {
    items: rows.map((row) => ({
      id: row.id,
      ownerId: row.owner_id,
      ownerName: row.owner_name,
      kind: row.kind,
      filename: row.filename,
      mime: row.mime,
      size: row.size,
      sha256: row.sha256,
      url: row.deleted_at ? null : attachmentsRepo.attachmentUrl(row.storage_key),
      createdAt: row.created_at,
      deleted: row.deleted_at !== null,
    })),
    total: totalRow?.c ?? 0,
  }
}

/** 管理员下架附件：行置 deleted，磁盘文件交给定时 GC 与孤儿回收 */
export async function deleteFile(db: DB, attachmentId: string): Promise<void> {
  const row = await one<attachmentsRepo.AttachmentRow>(db, 'SELECT * FROM attachments WHERE id = ?', [
    attachmentId,
  ])
  if (!row) throw err.notFound('附件不存在')
  if (row.deleted_at === null) {
    await run(db, 'UPDATE attachments SET deleted_at = ?, updated_at = ? WHERE id = ?', [
      now(),
      now(),
      attachmentId,
    ])
  }
}

export async function runGc(db: DB): Promise<AttachmentGcResult> {
  return await reclaimAttachments(db)
}

/* ------------------------------ AI 用量 ------------------------------ */

export interface AdminAiUsage {
  window: string
  totals: { calls: number; promptTokens: number; completionTokens: number; cachedTokens: number }
  byKind: Array<{ kind: string; calls: number; promptTokens: number; completionTokens: number }>
  byModel: Array<{ model: string | null; calls: number; promptTokens: number; completionTokens: number }>
  byUser: Array<{
    userId: string
    displayName: string | null
    calls: number
    promptTokens: number
    completionTokens: number
  }>
}

const AI_WINDOW_MS: Record<string, number> = {
  '24h': 24 * 3_600_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
}
const DEFAULT_AI_WINDOW_MS = 7 * 86_400_000

export async function aiUsageOverview(db: DB, window: '24h' | '7d' | '30d'): Promise<AdminAiUsage> {
  const from = now() - (AI_WINDOW_MS[window] ?? DEFAULT_AI_WINDOW_MS)

  const totals = await one<{ calls: number; p: number; c: number; cached: number }>(
    db,
    `SELECT COUNT(*) AS calls,
            COALESCE(SUM(prompt_tokens), 0) AS p,
            COALESCE(SUM(completion_tokens), 0) AS c,
            COALESCE(SUM(cached_tokens), 0) AS cached
       FROM ai_usage_log WHERE created_at >= ?`,
    [from],
  )
  const byKind = await all<{ kind: string; calls: number; p: number; c: number }>(
    db,
    `SELECT kind, COUNT(*) AS calls, COALESCE(SUM(prompt_tokens), 0) AS p, COALESCE(SUM(completion_tokens), 0) AS c
       FROM ai_usage_log WHERE created_at >= ?
      GROUP BY kind ORDER BY calls DESC`,
    [from],
  )
  const byModel = await all<{ model: string | null; calls: number; p: number; c: number }>(
    db,
    `SELECT model, COUNT(*) AS calls, COALESCE(SUM(prompt_tokens), 0) AS p, COALESCE(SUM(completion_tokens), 0) AS c
       FROM ai_usage_log WHERE created_at >= ?
      GROUP BY model ORDER BY calls DESC`,
    [from],
  )
  const byUser = await all<{
    owner_id: string
    display_name: string | null
    calls: number
    p: number
    c: number
  }>(
    db,
    `SELECT l.owner_id, u.display_name, COUNT(*) AS calls,
            COALESCE(SUM(l.prompt_tokens), 0) AS p, COALESCE(SUM(l.completion_tokens), 0) AS c
       FROM ai_usage_log l LEFT JOIN users u ON u.id = l.owner_id
      WHERE l.created_at >= ?
      GROUP BY l.owner_id, u.display_name ORDER BY calls DESC LIMIT 20`,
    [from],
  )

  return {
    window,
    totals: {
      calls: totals?.calls ?? 0,
      promptTokens: Number(totals?.p ?? 0),
      completionTokens: Number(totals?.c ?? 0),
      cachedTokens: Number(totals?.cached ?? 0),
    },
    byKind: byKind.map((r) => ({
      kind: r.kind,
      calls: r.calls,
      promptTokens: Number(r.p),
      completionTokens: Number(r.c),
    })),
    byModel: byModel.map((r) => ({
      model: r.model,
      calls: r.calls,
      promptTokens: Number(r.p),
      completionTokens: Number(r.c),
    })),
    byUser: byUser.map((r) => ({
      userId: r.owner_id,
      displayName: r.display_name,
      calls: r.calls,
      promptTokens: Number(r.p),
      completionTokens: Number(r.c),
    })),
  }
}

/* ------------------------------ 审计 ------------------------------ */

export async function listAudit(db: DB, page: number) {
  return await adminAuditRepo.listPage(db, page, PAGE_SIZE)
}
