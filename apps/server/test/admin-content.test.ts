import { testDatabaseUrl } from './helpers/pg'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

/**
 * 管理面板·内容管理：会话列表/消息查看/管理员撤回、动态与评论下架、
 * 文件列表与删除、手动 GC。
 * 内容脱敏：管理端接口不下发消息/动态/评论正文与 meta（附件 URL、引用摘要），
 * 管理员只能看到元信息，正文以「[内容已隐藏]」占位。
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'nenochat-admin-content-'))
process.env.NODE_ENV = 'test'
process.env.DATA_DIR = dataDir
process.env.DATABASE_URL = testDatabaseUrl(import.meta.url)
process.env.LOG_LEVEL = 'fatal'
process.env.JWT_SECRET = 'test-jwt-secret-at-least-16-chars'
process.env.SECRET_KEY = 'test-aes-secret-at-least-16-chars'

let app: FastifyInstance
let adminToken = ''
let bobToken = ''
let bobId = ''

function device(id: string) {
  return { id, name: `设备-${id}`, platform: 'win32', appVersion: '0.1.0' }
}

async function api(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: any }> {
  const res = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body !== undefined ? { payload: JSON.stringify(options.body) } : {}),
  })
  return { status: res.statusCode, json: res.json() }
}

async function register(username: string) {
  const res = await api('POST', '/auth/register', {
    body: { username, password: 'pass12345', displayName: username, device: device(`dev-${username}`) },
  })
  expect(res.status).toBe(200)
  return { id: res.json.user.id as string, token: res.json.tokens.accessToken as string }
}

/** 只满足魔数校验的最小 PNG */
function pngBuffer(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(24, 0x02),
  ])
}

async function uploadFile(token: string, kind = 'file'): Promise<{ id: string; url: string }> {
  const boundary = '----nenochatAdminBoundary'
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="admin-test.png"\r\n` +
      `Content-Type: image/png\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/files?kind=${kind}`,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([head, pngBuffer(), tail]),
  })
  expect(res.statusCode).toBe(200)
  const attachment = (res.json() as { attachment: { id: string; url: string } }).attachment
  return { id: attachment.id, url: attachment.url }
}

beforeAll(async () => {
  const { buildApp } = await import('../src/app')
  app = await buildApp()
  await app.ready()

  const admin = await register('root_admin')
  adminToken = admin.token
  const bob = await register('bob_speaker')
  bobToken = bob.token
  bobId = bob.id
})

afterAll(async () => {
  await app.close()
  const { closeDb } = await import('../src/db')
  closeDb()
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* 临时目录残留不影响测试结果 */
  }
})

describe('管理面板·内容管理', () => {
  it('会话列表带成员数与消息数，支持类型过滤', async () => {
    const conv = await api('POST', '/conversations', {
      token: adminToken,
      body: { type: 'group', name: '内容管理群', memberIds: [] },
    })
    expect(conv.status).toBe(200)
    const conversationId = conv.json.conversation.id

    const list = await api('GET', '/admin/conversations?type=group', { token: adminToken })
    expect(list.status).toBe(200)
    const item = list.json.items.find((c: any) => c.id === conversationId)
    expect(item).toBeTruthy()
    expect(item.memberCount).toBe(1)
    expect(item.name).toBe('内容管理群')

    const aiOnly = await api('GET', '/admin/conversations?type=ai', { token: adminToken })
    expect(aiOnly.json.total).toBe(0)
  })

  it('管理员查看任意会话消息并撤回他人消息', async () => {
    const conv = await api('POST', '/conversations', {
      token: adminToken,
      body: { type: 'direct', targetUserId: bobId },
    })
    const conversationId = conv.json.conversation.id

    const send = await api('POST', '/messages', {
      token: bobToken,
      body: { conversationId, type: 'text', content: '违规内容测试', clientNonce: 'adm-c-1' },
    })
    expect(send.status).toBe(200)
    const messageId = send.json.message.id

    // 回复一条制造 meta.replyTo 引用摘要，验证摘要同样不下发
    const reply = await api('POST', '/messages', {
      token: adminToken,
      body: { conversationId, type: 'text', content: '回复引用内容', clientNonce: 'adm-c-2', replyToId: messageId },
    })
    expect(reply.status).toBe(200)

    const listed = await api('GET', `/admin/conversations/${conversationId}/messages`, { token: adminToken })
    expect(listed.status).toBe(200)
    expect(listed.json.items).toHaveLength(2)
    for (const item of listed.json.items) {
      expect(item.content).toBe('[内容已隐藏]')
      expect(item.meta).toBeUndefined()
    }
    expect(listed.json.items.some((m: any) => m.senderName === 'bob_speaker')).toBe(true)
    // 正文与引用摘要都不允许出现在响应任何字段里
    expect(JSON.stringify(listed.json)).not.toContain('违规内容测试')
    expect(JSON.stringify(listed.json)).not.toContain('回复引用内容')

    const recall = await api('DELETE', `/admin/messages/${messageId}`, { token: adminToken })
    expect(recall.status).toBe(200)
    expect(recall.json.message.deletedAt).toBeGreaterThan(0)
    expect(recall.json.message.content).toBe('')

    // 软删后不再出现在管理员列表里（只剩未撤回的回复那条）；普通分页返回墓碑（deletedAt 置位、内容清空，客户端渲染「已撤回」）
    const after = await api('GET', `/admin/conversations/${conversationId}/messages`, { token: adminToken })
    expect(after.json.items.find((m: any) => m.id === messageId)).toBeUndefined()
    expect(after.json.items).toHaveLength(1)
    const userView = await api('GET', `/conversations/${conversationId}/messages`, { token: bobToken })
    const tombstone = userView.json.messages.find((m: any) => m.id === messageId)
    expect(tombstone.deletedAt).toBeGreaterThan(0)
    expect(tombstone.content).toBe('')
  })

  it('动态与评论下架', async () => {
    const post = await api('POST', '/posts', {
      token: bobToken,
      body: { content: '待下架的动态内容' },
    })
    expect(post.status).toBe(200)
    const postId = post.json.post.id

    const comment = await api('POST', `/posts/${postId}/comments`, {
      token: adminToken,
      body: { content: '待删除的评论' },
    })
    expect(comment.status).toBe(200)
    const commentId = comment.json.comment.id

    const listed = await api('GET', '/admin/posts?q=待下架', { token: adminToken })
    expect(listed.json.total).toBe(1)
    expect(listed.json.items[0].authorName).toBe('bob_speaker')
    expect(listed.json.items[0].content).toBe('[内容已隐藏]')
    expect(JSON.stringify(listed.json)).not.toContain('待下架的动态内容')

    // 评论区正文同样脱敏，作者信息保留
    const comments = await api('GET', `/admin/posts/${postId}/comments`, { token: adminToken })
    expect(comments.status).toBe(200)
    expect(comments.json.comments).toHaveLength(1)
    expect(comments.json.comments[0].content).toBe('[内容已隐藏]')
    expect(comments.json.comments[0].author?.displayName).toBe('root_admin')
    expect(JSON.stringify(comments.json)).not.toContain('待删除的评论')

    const delComment = await api('DELETE', `/admin/comments/${commentId}`, { token: adminToken })
    expect(delComment.status).toBe(200)

    const delPost = await api('DELETE', `/admin/posts/${postId}`, { token: adminToken })
    expect(delPost.status).toBe(200)

    const after = await api('GET', '/admin/posts', { token: adminToken })
    expect(after.json.items.find((p: any) => p.id === postId)).toBeUndefined()

    // 作者侧也看不到了
    const authorFeed = await api('GET', '/posts', { token: bobToken })
    expect(authorFeed.json.posts.find((p: any) => p.id === postId)).toBeUndefined()
  })

  it('文件列表、删除与手动 GC', async () => {
    const uploaded = await uploadFile(adminToken, 'avatar')
    expect(uploaded.url).toContain('/files/')

    const list = await api('GET', '/admin/files?kind=avatar', { token: adminToken })
    expect(list.status).toBe(200)
    const row = list.json.items.find((f: any) => f.id === uploaded.id)
    expect(row).toBeTruthy()
    expect(row.ownerName).toBe('root_admin')
    expect(row.size).toBeGreaterThan(0)

    const del = await api('DELETE', `/admin/files/${uploaded.id}`, { token: adminToken })
    expect(del.status).toBe(200)

    const after = await api('GET', '/admin/files?kind=avatar', { token: adminToken })
    expect(after.json.items.find((f: any) => f.id === uploaded.id)).toBeUndefined()

    // 含已删除时能看到，且标记 deleted
    const withDeleted = await api('GET', '/admin/files?kind=avatar&includeDeleted=true', { token: adminToken })
    const deletedRow = withDeleted.json.items.find((f: any) => f.id === uploaded.id)
    expect(deletedRow.deleted).toBe(true)

    const gc = await api('POST', '/admin/files/gc', { token: adminToken })
    expect(gc.status).toBe(200)
    expect(gc.json.result).toHaveProperty('freedBytes')
  })

  it('统计接口能聚合出内容数据', async () => {
    // 造一条在屏消息、一个未删除附件，保证统计非零
    const conv = await api('POST', '/conversations', {
      token: adminToken,
      body: { type: 'direct', targetUserId: bobId },
    })
    const conversationId = conv.json.conversation.id
    const send = await api('POST', '/messages', {
      token: bobToken,
      body: { conversationId, type: 'text', content: '统计用消息', clientNonce: 'adm-stats-1' },
    })
    expect(send.status).toBe(200)
    await uploadFile(bobToken, 'file')

    const stats = await api('GET', '/admin/stats', { token: adminToken })
    expect(stats.status).toBe(200)
    expect(stats.json.messages.total).toBeGreaterThan(0)
    expect(stats.json.posts.total).toBe(0) // 唯一动态已删
    expect(stats.json.conversations.total).toBeGreaterThan(0)
    expect(stats.json.storage.attachments).toBeGreaterThan(0)
    expect(stats.json.recentUsers.length).toBeGreaterThan(0)
  })

  it('内容操作全部留痕审计', async () => {
    const audit = await api('GET', '/admin/audit', { token: adminToken })
    const actions = audit.json.items.map((a: any) => a.action)
    expect(actions).toContain('message.recall')
    expect(actions).toContain('post.delete')
    expect(actions).toContain('comment.delete')
    expect(actions).toContain('file.delete')
    expect(actions).toContain('file.gc')
  })
})
