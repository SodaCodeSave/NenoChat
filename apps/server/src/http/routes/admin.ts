import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { MAX_UPLOAD_IMAGE_BYTES, PASSWORD_MIN_LENGTH } from '@nenochat/shared'
import { getDb } from '../../db'
import { parse } from '../plugins/validate'
import { requireAdmin, type AdminIdentity } from '../plugins/auth'
import { env } from '../../env'
import { APP_VERSION, BUILD_STAMP, MIN_CLIENT_VERSION } from '../../version'
import * as adminService from '../../services/admin-service'
import {
  REGISTRATION_MODES,
  getRegistrationMode,
  getServerName,
  setRegistrationMode,
  setServerName,
} from '../../services/server-settings-service'
import * as adminAuditRepo from '../../db/repo/admin-audit'
import { err } from '../../util/errors'

/**
 * 管理面板 API。全部挂 /api/v1/admin/*，每个入口先过 requireAdmin
 * （JWT + 回库核对 is_admin），所有写操作写审计日志。
 */

const PageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
})

const ListUsersQuery = PageQuery.extend({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'disabled']).optional(),
})

const SetAdminBody = z.object({ isAdmin: z.boolean() })
const ResetPasswordBody = z.object({
  password: z.string().min(PASSWORD_MIN_LENGTH, `密码至少 ${PASSWORD_MIN_LENGTH} 位`).max(128, '密码过长'),
})
const CreateInviteBody = z.object({
  maxUses: z.number().int().min(1).max(1000),
  expiresInDays: z.number().int().min(1).max(3650).optional().nullable(),
})
const ListConversationsQuery = PageQuery.extend({
  type: z.enum(['direct', 'group', 'ai']).optional(),
  q: z.string().trim().max(100).optional(),
})
const ListMessagesQuery = z.object({
  beforeSeq: z.coerce.number().int().positive().optional(),
})
const ListPostsQuery = PageQuery.extend({ q: z.string().trim().max(100).optional() })
const ListFilesQuery = PageQuery.extend({
  kind: z.string().trim().max(32).optional(),
  q: z.string().trim().max(100).optional(),
  includeDeleted: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
})
const AiUsageQuery = z.object({ window: z.enum(['24h', '7d', '30d']).default('7d') })
const UpdateSettingsBody = z.object({
  serverName: z.string().trim().min(1, '服务器名不能为空').max(50, '服务器名过长').optional(),
  registrationMode: z.enum(['open', 'invite', 'closed']).optional(),
})

async function recordAudit(
  db: ReturnType<typeof getDb>,
  admin: AdminIdentity,
  action: string,
  targetType: string,
  targetId?: string | null,
  detail?: unknown,
): Promise<void> {
  await adminAuditRepo.insert(db, {
    actorId: admin.userId,
    action,
    targetType,
    targetId: targetId ?? null,
    detail,
  })
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb()

  /* ------------------------------ 概览 ------------------------------ */

  app.get('/admin/stats', async (request) => {
    await requireAdmin(request)
    return await adminService.getStats(db)
  })

  /* ------------------------------ 用户 ------------------------------ */

  app.get('/admin/users', async (request) => {
    await requireAdmin(request)
    const query = parse(ListUsersQuery, request.query)
    return await adminService.listUsers(db, query)
  })

  app.get<{ Params: { id: string } }>('/admin/users/:id', async (request) => {
    await requireAdmin(request)
    return await adminService.getUserDetail(db, request.params.id)
  })

  app.get<{ Params: { id: string } }>('/admin/users/:id/devices', async (request) => {
    await requireAdmin(request)
    return await adminService.listUserDevices(db, request.params.id)
  })

  app.delete<{ Params: { id: string; deviceId: string } }>('/admin/users/:id/devices/:deviceId', async (request) => {
    const admin = await requireAdmin(request)
    await adminService.removeUserDevice(db, request.params.id, request.params.deviceId)
    await recordAudit(db, admin, 'device.remove', 'device', request.params.deviceId, {
      userId: request.params.id,
    })
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/admin/users/:id/disable', async (request) => {
    const admin = await requireAdmin(request)
    const user = await adminService.setUserStatus(db, request.params.id, 'disabled')
    await recordAudit(db, admin, 'user.disable', 'user', request.params.id)
    return { user }
  })

  app.post<{ Params: { id: string } }>('/admin/users/:id/enable', async (request) => {
    const admin = await requireAdmin(request)
    const user = await adminService.setUserStatus(db, request.params.id, 'active')
    await recordAudit(db, admin, 'user.enable', 'user', request.params.id)
    return { user }
  })

  app.post<{ Params: { id: string } }>('/admin/users/:id/reset-password', async (request) => {
    const admin = await requireAdmin(request)
    const input = parse(ResetPasswordBody, request.body)
    await adminService.resetPassword(db, request.params.id, input.password)
    // 审计里绝不落密码内容
    await recordAudit(db, admin, 'user.reset_password', 'user', request.params.id)
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/admin/users/:id/set-admin', async (request) => {
    const admin = await requireAdmin(request)
    const input = parse(SetAdminBody, request.body)
    if (request.params.id === admin.userId && !input.isAdmin) {
      throw err.forbidden('不能撤销自己的管理员权限')
    }
    const user = await adminService.setIsAdmin(db, request.params.id, input.isAdmin)
    await recordAudit(db, admin, 'user.set_admin', 'user', request.params.id, { isAdmin: input.isAdmin })
    return { user }
  })

  app.delete<{ Params: { id: string } }>('/admin/users/:id', async (request) => {
    const admin = await requireAdmin(request)
    const result = await adminService.deleteUser(db, request.params.id, admin.userId)
    await recordAudit(db, admin, 'user.delete', 'user', request.params.id, {
      removedMessages: result.removedMessages.length,
      removedPosts: result.removedPostIds.length,
      transferredConversations: result.transferredConversations.length,
    })
    return { ok: true }
  })

  /* ------------------------------ 邀请码 ------------------------------ */

  app.get('/admin/invites', async (request) => {
    await requireAdmin(request)
    return await adminService.listInvites(db)
  })

  app.post('/admin/invites', async (request) => {
    const admin = await requireAdmin(request)
    const input = parse(CreateInviteBody, request.body)
    const invite = await adminService.createInvite(db, admin.userId, input)
    await recordAudit(db, admin, 'invite.create', 'invite', invite.code, {
      maxUses: input.maxUses,
      expiresInDays: input.expiresInDays ?? null,
    })
    return { invite }
  })

  app.delete<{ Params: { code: string } }>('/admin/invites/:code', async (request) => {
    const admin = await requireAdmin(request)
    await adminService.deleteInvite(db, request.params.code)
    await recordAudit(db, admin, 'invite.delete', 'invite', request.params.code)
    return { ok: true }
  })

  /* ------------------------------ 会话与消息 ------------------------------ */

  app.get('/admin/conversations', async (request) => {
    await requireAdmin(request)
    const query = parse(ListConversationsQuery, request.query)
    return await adminService.listConversations(db, query)
  })

  app.get<{ Params: { id: string } }>('/admin/conversations/:id/messages', async (request) => {
    await requireAdmin(request)
    const query = parse(ListMessagesQuery, request.query)
    return await adminService.listConversationMessages(db, request.params.id, query)
  })

  app.delete<{ Params: { id: string } }>('/admin/messages/:id', async (request) => {
    const admin = await requireAdmin(request)
    const message = await adminService.recallMessage(db, request.params.id, admin.userId)
    await recordAudit(db, admin, 'message.recall', 'message', request.params.id, {
      conversationId: message.conversationId,
    })
    return { message }
  })

  /* ------------------------------ 动态与评论 ------------------------------ */

  app.get('/admin/posts', async (request) => {
    await requireAdmin(request)
    const query = parse(ListPostsQuery, request.query)
    return await adminService.listPosts(db, query)
  })

  app.delete<{ Params: { id: string } }>('/admin/posts/:id', async (request) => {
    const admin = await requireAdmin(request)
    await adminService.deletePost(db, request.params.id)
    await recordAudit(db, admin, 'post.delete', 'post', request.params.id)
    return { ok: true }
  })

  app.delete<{ Params: { id: string } }>('/admin/comments/:id', async (request) => {
    const admin = await requireAdmin(request)
    const result = await adminService.deleteComment(db, request.params.id)
    await recordAudit(db, admin, 'comment.delete', 'comment', request.params.id, {
      postId: result.postId,
    })
    return { ok: true }
  })

  /* ------------------------------ 文件与存储 ------------------------------ */

  app.get('/admin/files', async (request) => {
    await requireAdmin(request)
    const query = parse(ListFilesQuery, request.query)
    return await adminService.listFiles(db, query)
  })

  app.delete<{ Params: { id: string } }>('/admin/files/:id', async (request) => {
    const admin = await requireAdmin(request)
    await adminService.deleteFile(db, request.params.id)
    await recordAudit(db, admin, 'file.delete', 'attachment', request.params.id)
    return { ok: true }
  })

  app.post('/admin/files/gc', async (request) => {
    const admin = await requireAdmin(request)
    const result = await adminService.runGc(db)
    await recordAudit(db, admin, 'file.gc', 'storage', null, { ...result })
    return { result }
  })

  /* ------------------------------ 服务器设置 ------------------------------ */

  app.get('/admin/settings', async (request) => {
    await requireAdmin(request)
    const [serverName, registrationMode] = await Promise.all([
      getServerName(db),
      getRegistrationMode(db),
    ])
    return {
      serverName,
      registrationMode,
      env: { serverName: env.SERVER_NAME, registrationMode: env.REGISTRATION_MODE },
      version: APP_VERSION,
      buildStamp: BUILD_STAMP,
      minClientVersion: MIN_CLIENT_VERSION,
      maxUploadMb: Math.round(MAX_UPLOAD_IMAGE_BYTES / (1024 * 1024)),
    }
  })

  app.patch('/admin/settings', async (request) => {
    const admin = await requireAdmin(request)
    const input = parse(UpdateSettingsBody, request.body)
    const detail: Record<string, unknown> = {}
    if (input.serverName !== undefined) {
      await setServerName(db, input.serverName)
      detail.serverName = input.serverName
    }
    if (input.registrationMode !== undefined) {
      await setRegistrationMode(db, input.registrationMode)
      detail.registrationMode = input.registrationMode
    }
    await recordAudit(db, admin, 'settings.update', 'server_settings', null, detail)
    const [serverName, registrationMode] = await Promise.all([
      getServerName(db),
      getRegistrationMode(db),
    ])
    return { serverName, registrationMode }
  })

  /* ------------------------------ AI 用量 ------------------------------ */

  app.get('/admin/ai/usage', async (request) => {
    await requireAdmin(request)
    const query = parse(AiUsageQuery, request.query)
    return await adminService.aiUsageOverview(db, query.window)
  })

  /* ------------------------------ 审计日志 ------------------------------ */

  app.get('/admin/audit', async (request) => {
    await requireAdmin(request)
    const query = parse(PageQuery, request.query)
    return await adminService.listAudit(db, query.page)
  })
}
