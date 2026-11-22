import { testDatabaseUrl } from './helpers/pg'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

/**
 * 集成测试：用 Fastify 的 inject 直连应用，不占端口。
 * 所有断言都走真实路由 + 真实数据库，覆盖权限、幂等、seq 与增量同步。
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'nenochat-test-'))
process.env.NODE_ENV = 'test'
process.env.DATA_DIR = dataDir
process.env.DATABASE_URL = testDatabaseUrl(import.meta.url)
process.env.LOG_LEVEL = 'fatal'
process.env.REGISTRATION_MODE = 'open'
process.env.JWT_SECRET = 'test-jwt-secret-at-least-16-chars'
process.env.SECRET_KEY = 'test-aes-secret-at-least-16-chars'

let app: FastifyInstance

interface Session {
  accessToken: string
  refreshToken: string
  user: { id: string; username: string }
}

function device(id: string) {
  return { id, name: `设备-${id}`, platform: 'win32', appVersion: '0.1.0' }
}

async function api<T = any>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: T }> {
  const res = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body !== undefined ? { payload: JSON.stringify(options.body) } : {}),
  })
  return { status: res.statusCode, json: res.json() as T }
}

async function register(username: string, displayName: string, deviceId: string): Promise<Session> {
  const res = await api<{ user: { id: string; username: string }; tokens: Session }>('POST', '/auth/register', {
    body: { username, password: 'pass12345', displayName, device: device(deviceId) },
  })
  if (res.status !== 200) throw new Error(`注册失败: ${JSON.stringify(res.json)}`)
  return { ...res.json.tokens, user: res.json.user }
}

beforeAll(async () => {
  const { buildApp } = await import('../src/app')
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  await app.close()
  // 先关掉数据库连接池，避免资源泄漏影响后续清理
  const { closeDb } = await import('../src/db')
  await closeDb()
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* 临时目录残留不影响测试结果 */
  }
})

describe('鉴权', () => {
  it('首个注册用户自动成为管理员，且不返回密码散列', async () => {
    const alice = await register('alice', '爱丽丝', 'dev-a')
    expect(alice.user.username).toBe('alice')

    const me = await api('GET', '/auth/me', { token: alice.accessToken })
    expect(me.status).toBe(200)
    expect(me.json.user.isAdmin).toBe(true)
    expect(JSON.stringify(me.json)).not.toContain('password')
  })

  it('重复用户名返回 409', async () => {
    const res = await api('POST', '/auth/register', {
      body: { username: 'alice', password: 'pass12345', displayName: '重复', device: device('dev-x') },
    })
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('CONFLICT')
  })

  it('无 token 访问受保护接口返回 401', async () => {
    const res = await api('GET', '/auth/me')
    expect(res.status).toBe(401)
  })

  it('刷新后旧 refresh token 不可再用（重放检测）', async () => {
    const bob = await register('bob', '鲍勃', 'dev-b')
    const refreshed = await api<{ tokens: Session }>('POST', '/auth/refresh', {
      body: { refreshToken: bob.refreshToken, device: { id: 'dev-b' } },
    })
    expect(refreshed.status).toBe(200)

    const replay = await api('POST', '/auth/refresh', {
      body: { refreshToken: bob.refreshToken, device: { id: 'dev-b' } },
    })
    expect(replay.status).toBe(401)
  })
})

describe('会话与消息', () => {
  let alice: Session
  let bob: Session
  let carol: Session

  beforeAll(async () => {
    alice = await register('u_alice', '爱丽丝', 'dev-a')
    bob = await register('u_bob', '鲍勃', 'dev-b')
    carol = await register('u_carol', '卡罗尔', 'dev-c')
  })

  it('私聊是幂等的：同一对用户重复创建得到同一会话', async () => {
    const first = await api<{ conversation: { id: string } }>('POST', '/conversations', {
      token: alice.accessToken,
      body: { type: 'direct', targetUserId: bob.user.id },
    })
    const second = await api<{ conversation: { id: string } }>('POST', '/conversations', {
      token: bob.accessToken,
      body: { type: 'direct', targetUserId: alice.user.id },
    })
    expect(first.status).toBe(200)
    expect(second.json.conversation.id).toBe(first.json.conversation.id)
  })

  it('发消息分配连续 seq，且相同 nonce 只落一条', async () => {
    const conv = await api<{ conversation: { id: string } }>('POST', '/conversations', {
      token: alice.accessToken,
      body: { type: 'direct', targetUserId: carol.user.id },
    })
    const conversationId = conv.json.conversation.id

    const first = await api<{ message: { id: string; seq: number }; duplicated: boolean }>('POST', '/messages', {
      token: alice.accessToken,
      body: { conversationId, clientNonce: 'n-1', type: 'text', content: '你好' },
    })
    const dup = await api<{ message: { id: string }; duplicated: boolean }>('POST', '/messages', {
      token: alice.accessToken,
      body: { conversationId, clientNonce: 'n-1', type: 'text', content: '你好' },
    })

    expect(first.json.message.seq).toBe(1)
    expect(dup.json.duplicated).toBe(true)
    expect(dup.json.message.id).toBe(first.json.message.id)

    await api('POST', '/messages', {
      token: carol.accessToken,
      body: { conversationId, clientNonce: 'n-2', type: 'text', content: '你也好' },
    })

    const page = await api<{ messages: Array<{ seq: number; content: string }> }>(
      'GET',
      `/conversations/${conversationId}/messages?limit=50`,
      { token: carol.accessToken },
    )
    expect(page.json.messages.map((m) => m.seq)).toEqual([1, 2])
    expect(page.json.messages.map((m) => m.content)).toEqual(['你好', '你也好'])
  })

  it('引用回复会带上被引消息的快照，引用不存在的消息被拒绝', async () => {
    const conv = await api<{ conversation: { id: string } }>('POST', '/conversations', {
      token: alice.accessToken,
      body: { type: 'direct', targetUserId: bob.user.id },
    })
    const conversationId = conv.json.conversation.id

    const origin = await api<{ message: { id: string } }>('POST', '/messages', {
      token: alice.accessToken,
      body: { conversationId, clientNonce: 'q-1', type: 'text', content: '周末去看展吗' },
    })

    const reply = await api<{
      message: {
        replyToId: string | null
        meta: { replyTo?: { id: string; senderName: string; preview: string } }
      }
    }>('POST', '/messages', {
      token: bob.accessToken,
      body: {
        conversationId,
        clientNonce: 'q-2',
        type: 'text',
        content: '去啊',
        replyToId: origin.json.message.id,
      },
    })

    expect(reply.json.message.replyToId).toBe(origin.json.message.id)
    expect(reply.json.message.meta.replyTo).toMatchObject({
      id: origin.json.message.id,
      senderName: '爱丽丝',
      preview: '周末去看展吗',
    })

    const missing = await api('POST', '/messages', {
      token: bob.accessToken,
      body: { conversationId, clientNonce: 'q-3', type: 'text', content: '？', replyToId: 'not-exist' },
    })
    expect(missing.status).toBe(400)
  })

  it('非成员无法读取会话消息', async () => {
    const conv = await api<{ conversation: { id: string } }>('POST', '/conversations', {
      token: alice.accessToken,
      body: { type: 'direct', targetUserId: bob.user.id },
    })
    const res = await api('GET', `/conversations/${conv.json.conversation.id}/messages`, {
      token: carol.accessToken,
    })
    expect(res.status).toBe(403)
  })

  it('群聊只有一条消息流，普通成员无管理权限', async () => {
    const group = await api<{
      conversation: { id: string; type: string }
      channels?: unknown
    }>('POST', '/conversations', {
      token: alice.accessToken,
      body: { type: 'group', name: '测试群', memberIds: [bob.user.id] },
    })
    expect(group.json.conversation.type).toBe('group')
    expect(group.json.channels).toBeUndefined()

    const groupId = group.json.conversation.id

    const deny = await api('PATCH', `/conversations/${groupId}`, {
      token: bob.accessToken,
      body: { announcement: '普通成员不能改公告' },
    })
    expect(deny.status).toBe(403)

    const rename = await api('PATCH', `/conversations/${groupId}`, {
      token: alice.accessToken,
      body: { announcement: '本群公告：请勿刷屏' },
    })
    expect(rename.status).toBe(200)
    expect(rename.json.conversation.announcement).toBe('本群公告：请勿刷屏')
  })

  it('已读游标只前进不后退', async () => {
    const group = await api<{ conversation: { id: string } }>('POST', '/conversations', {
      token: alice.accessToken,
      body: { type: 'group', name: '已读测试', memberIds: [bob.user.id] },
    })
    const groupId = group.json.conversation.id

    await api('POST', '/messages', {
      token: alice.accessToken,
      body: { conversationId: groupId, clientNonce: 'r-1', type: 'text', content: '一' },
    })

    const forward = await api<{ advanced: boolean; lastReadSeq: number }>(
      'POST',
      `/conversations/${groupId}/read`,
      { token: bob.accessToken, body: { messageSeq: 1 } },
    )
    expect(forward.json).toEqual({ advanced: true, lastReadSeq: 1 })

    const backward = await api<{ advanced: boolean; lastReadSeq: number }>(
      'POST',
      `/conversations/${groupId}/read`,
      { token: bob.accessToken, body: { messageSeq: 0 } },
    )
    expect(backward.json.advanced).toBe(false)
    expect(backward.json.lastReadSeq).toBe(1)
  })

  it('增量同步按可见性过滤，非成员拉不到别人的私聊消息', async () => {
    const aliceSync = await api<{ changes: Array<{ entity: string }>; nextCursor: number }>(
      'GET',
      '/sync/changes?since=0&limit=1000',
      { token: alice.accessToken },
    )
    const carolSync = await api<{ changes: Array<{ entity: string }> }>('GET', '/sync/changes?since=0&limit=1000', {
      token: carol.accessToken,
    })

    expect(aliceSync.json.changes.length).toBeGreaterThan(0)
    expect(aliceSync.json.nextCursor).toBeGreaterThan(0)

    // 卡罗尔没有参与「爱丽丝与鲍勃」的私聊，变更数量应明显少于爱丽丝
    expect(carolSync.json.changes.length).toBeLessThan(aliceSync.json.changes.length)
  })

  it('撤回写墓碑而非物理删除', async () => {
    const conv = await api<{ conversation: { id: string } }>('POST', '/conversations', {
      token: alice.accessToken,
      body: { type: 'direct', targetUserId: bob.user.id },
    })
    const conversationId = conv.json.conversation.id

    const sent = await api<{ message: { id: string } }>('POST', '/messages', {
      token: alice.accessToken,
      body: { conversationId, clientNonce: 'del-1', type: 'text', content: '待撤回' },
    })

    const recalled = await api<{ message: { deletedAt: number | null; content: string } }>(
      'DELETE',
      `/messages/${sent.json.message.id}`,
      { token: alice.accessToken },
    )
    expect(recalled.json.message.deletedAt).not.toBeNull()
    expect(recalled.json.message.content).toBe('')
  })

  it('普通成员不能撤回他人消息', async () => {
    const group = await api<{ conversation: { id: string } }>('POST', '/conversations', {
      token: alice.accessToken,
      body: { type: 'group', name: '撤回权限', memberIds: [bob.user.id] },
    })
    const conversationId = group.json.conversation.id

    const sent = await api<{ message: { id: string } }>('POST', '/messages', {
      token: alice.accessToken,
      body: { conversationId, clientNonce: 'recall-perm-1', type: 'text', content: '群主发的消息' },
    })

    const denied = await api('DELETE', `/messages/${sent.json.message.id}`, {
      token: bob.accessToken,
    })
    expect(denied.status).toBe(403)
  })

  it('会话列表带最后一条消息摘要，撤回后摘要标记已撤回', async () => {
    const group = await api<{ conversation: { id: string } }>('POST', '/conversations', {
      token: alice.accessToken,
      body: { type: 'group', name: '列表摘要', memberIds: [bob.user.id] },
    })
    const conversationId = group.json.conversation.id

    const sent = await api<{ message: { id: string } }>('POST', '/messages', {
      token: alice.accessToken,
      body: { conversationId, clientNonce: 'preview-1', type: 'text', content: '侧边栏预览测试' },
    })
    expect(sent.status).toBe(200)

    const list = await api<{
      conversations: Array<{
        id: string
        lastMessageSummary: { senderId: string; type: string; content: string; deleted: boolean } | null
      }>
    }>('GET', '/conversations', { token: alice.accessToken })
    const target = list.json.conversations.find((c) => c.id === conversationId)
    expect(target?.lastMessageSummary).toMatchObject({
      senderId: alice.user.id,
      type: 'text',
      content: '侧边栏预览测试',
      deleted: false,
    })

    // 撤回最后一条消息后，列表摘要应同步标记，客户端才能显示「消息已撤回」
    const recalled = await api('DELETE', `/messages/${sent.json.message.id}`, {
      token: alice.accessToken,
    })
    expect(recalled.status).toBe(200)

    const refreshed = await api<{
      conversations: Array<{ id: string; lastMessageSummary: { content: string; deleted: boolean } | null }>
    }>('GET', '/conversations', { token: bob.accessToken })
    const after = refreshed.json.conversations.find((c) => c.id === conversationId)
    expect(after?.lastMessageSummary).toMatchObject({ deleted: true })
  })
})

describe('同步变更日志', () => {
  it('每条写入都在同事务内落一条变更', async () => {
    const { getDb, one } = await import('../src/db')
    const db = getDb()
    const row = (await one<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM sync_change_log'))!
    expect(row.c).toBeGreaterThan(0)

    const mismatch = (await one<{ c: number }>(
      db,
      `SELECT COUNT(*) AS c FROM messages m
         WHERE NOT EXISTS (
           SELECT 1 FROM sync_change_log cl WHERE cl.entity = 'message' AND cl.entity_id = m.id
         )`,
    ))!
    expect(mismatch.c).toBe(0)
  })
})
