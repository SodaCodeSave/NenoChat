import { testDatabaseUrl } from './helpers/pg'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

/**
 * 转发集成测试：多选消息复制到目标会话。
 * 覆盖内容/meta 复制、forwardedFrom 标记、引用与提及剥离、
 * 撤回消息跳过、权限（源可读 / 目标可发 / 禁言）与变更日志一致性。
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
  const { closeDb } = await import('../src/db')
  await closeDb()
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* 临时目录残留不影响测试结果 */
  }
})

describe('消息转发', () => {
  let alice: Session
  let bob: Session
  let carol: Session
  /** 爱丽丝与鲍勃的私聊：转发来源 */
  let sourceDirect: string
  /** 测试群（爱丽丝创建，鲍勃在群内）：转发目标 */
  let targetGroup: string
  /** 爱丽丝与卡罗尔的私聊：卡罗尔不在来源会话，用于权限断言 */
  let carolDirect: string

  beforeAll(async () => {
    alice = await register('f_alice', '爱丽丝', 'dev-a')
    bob = await register('f_bob', '鲍勃', 'dev-b')
    carol = await register('f_carol', '卡罗尔', 'dev-c')

    const direct = await api<{ conversation: { id: string } }>('POST', '/conversations', {
      token: alice.accessToken,
      body: { type: 'direct', targetUserId: bob.user.id },
    })
    sourceDirect = direct.json.conversation.id

    const group = await api<{ conversation: { id: string } }>('POST', '/conversations', {
      token: alice.accessToken,
      body: { type: 'group', name: '转发测试群', memberIds: [bob.user.id] },
    })
    targetGroup = group.json.conversation.id

    const carolConv = await api<{ conversation: { id: string } }>('POST', '/conversations', {
      token: alice.accessToken,
      body: { type: 'direct', targetUserId: carol.user.id },
    })
    carolDirect = carolConv.json.conversation.id
  })

  it('文本与图片消息转发到群：content/type/attachments 原样复制并盖上转发来源', async () => {
    const text = await api<{ message: { id: string } }>('POST', '/messages', {
      token: alice.accessToken,
      body: { conversationId: sourceDirect, clientNonce: 'fw-1', type: 'text', content: '看看这张图' },
    })
    const image = await api<{ message: { id: string; meta: { attachments?: unknown[] } } }>('POST', '/messages', {
      token: alice.accessToken,
      body: {
        conversationId: sourceDirect,
        clientNonce: 'fw-2',
        type: 'image',
        content: '风景照',
        meta: {
          attachments: [
            {
              id: 'att-1',
              kind: 'image',
              filename: 'photo.png',
              mime: 'image/png',
              size: 1024,
              url: '/files/photo.png',
            },
          ],
        },
      },
    })

    const result = await api<{
      results: Array<{ conversationId: string; messages: Array<Record<string, unknown>> }>
    }>('POST', '/messages/forward', {
      token: alice.accessToken,
      body: { messageIds: [text.json.message.id, image.json.message.id], targetConversationIds: [targetGroup] },
    })
    expect(result.status).toBe(200)
    expect(result.json.results).toHaveLength(1)
    expect(result.json.results[0].conversationId).toBe(targetGroup)
    const forwarded = result.json.results[0].messages
    expect(forwarded).toHaveLength(2)

    expect(forwarded[0].type).toBe('text')
    expect(forwarded[0].content).toBe('看看这张图')
    expect(forwarded[0].senderType).toBe('user')
    expect(forwarded[0].senderId).toBe(alice.user.id)
    expect(forwarded[0].replyToId).toBeNull()
    expect(forwarded[0].clientNonce).toBeTruthy()

    expect(forwarded[1].type).toBe('image')
    expect(forwarded[1].content).toBe('风景照')
    expect(forwarded[1].meta).toMatchObject({
      forwardedFrom: '鲍勃',
      attachments: [{ id: 'att-1', url: '/files/photo.png' }],
    })

    // seq 在目标会话内连续
    const page = await api<{ messages: Array<{ seq: number; content: string }> }>(
      'GET',
      `/conversations/${targetGroup}/messages?limit=50`,
      { token: alice.accessToken },
    )
    const seqs = page.json.messages.map((m) => m.seq)
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
    expect(page.json.messages.some((m) => m.content === '看看这张图')).toBe(true)

    // 同一 nonce 不冲突：转发行的 nonce 与原消息不同
    expect(forwarded[0].clientNonce).not.toBe('fw-1')
  })

  it('引用与提及被剥掉，来源会话名正确', async () => {
    const origin = await api<{ message: { id: string } }>('POST', '/messages', {
      token: bob.accessToken,
      body: { conversationId: sourceDirect, clientNonce: 'fw-3', type: 'text', content: '原话' },
    })
    const reply = await api<{ message: { id: string } }>('POST', '/messages', {
      token: alice.accessToken,
      body: {
        conversationId: sourceDirect,
        clientNonce: 'fw-4',
        type: 'text',
        content: '收到 @鲍勃',
        replyToId: origin.json.message.id,
        meta: { mentions: [bob.user.id], mentionAll: false },
      },
    })

    const result = await api<{
      results: Array<{ messages: Array<{ meta: Record<string, unknown>; replyToId: string | null }> }>
    }>('POST', '/messages/forward', {
      token: alice.accessToken,
      body: { messageIds: [reply.json.message.id], targetConversationIds: [targetGroup] },
    })
    expect(result.status).toBe(200)
    const forwarded = result.json.results[0].messages[0]
    expect(forwarded.replyToId).toBeNull()
    expect(forwarded.meta.replyTo).toBeUndefined()
    expect(forwarded.meta.mentions).toBeUndefined()
    expect(forwarded.meta.mentionAll).toBeUndefined()
    expect(forwarded.meta.forwardedFrom).toBe('鲍勃')
  })

  it('从群聊转发时来源用群名，会话列表摘要随之更新', async () => {
    const msg = await api<{ message: { id: string } }>('POST', '/messages', {
      token: alice.accessToken,
      body: { conversationId: sourceDirect, clientNonce: 'fw-5', type: 'text', content: '私聊里的消息' },
    })
    const result = await api<{ results: Array<{ messages: Array<{ meta: Record<string, unknown> }> }> }>(
      'POST',
      '/messages/forward',
      {
        token: alice.accessToken,
        body: { messageIds: [msg.json.message.id], targetConversationIds: [carolDirect] },
      },
    )
    expect(result.status).toBe(200)
    // 私聊没有会话名，来源退回对方昵称
    expect(result.json.results[0].messages[0].meta.forwardedFrom).toBe('鲍勃')

    const list = await api<{ conversations: Array<{ id: string; lastMessageAt: number | null }> }>(
      'GET',
      '/conversations',
      { token: carol.accessToken },
    )
    const target = list.json.conversations.find((c) => c.id === carolDirect)
    expect(target?.lastMessageAt).toBeTruthy()
  })

  it('已撤回的消息被跳过，其余消息正常转发', async () => {
    const gone = await api<{ message: { id: string } }>('POST', '/messages', {
      token: alice.accessToken,
      body: { conversationId: sourceDirect, clientNonce: 'fw-6', type: 'text', content: '将撤回' },
    })
    await api('DELETE', `/messages/${gone.json.message.id}`, { token: alice.accessToken })
    const alive = await api<{ message: { id: string } }>('POST', '/messages', {
      token: alice.accessToken,
      body: { conversationId: sourceDirect, clientNonce: 'fw-7', type: 'text', content: '留下来' },
    })

    const result = await api<{ results: Array<{ messages: Array<{ content: string }> }> }>(
      'POST',
      '/messages/forward',
      {
        token: alice.accessToken,
        body: {
          messageIds: [gone.json.message.id, alive.json.message.id],
          targetConversationIds: [targetGroup],
        },
      },
    )
    expect(result.status).toBe(200)
    const forwarded = result.json.results[0].messages
    expect(forwarded).toHaveLength(1)
    expect(forwarded[0].content).toBe('留下来')
  })

  it('全部消息不可转发时返回参数错误', async () => {
    const missing = await api('POST', '/messages/forward', {
      token: alice.accessToken,
      body: { messageIds: ['not-exist-1'], targetConversationIds: [targetGroup] },
    })
    expect(missing.status).toBe(400)
  })

  it('不是来源会话成员无法转发', async () => {
    const msg = await api<{ message: { id: string } }>('POST', '/messages', {
      token: alice.accessToken,
      body: { conversationId: sourceDirect, clientNonce: 'fw-8', type: 'text', content: '私密' },
    })
    const result = await api('POST', '/messages/forward', {
      token: carol.accessToken,
      body: { messageIds: [msg.json.message.id], targetConversationIds: [carolDirect] },
    })
    expect(result.status).toBe(403)
  })

  it('不是目标会话成员无法转发进去', async () => {
    const msg = await api<{ message: { id: string } }>('POST', '/messages', {
      token: alice.accessToken,
      body: { conversationId: carolDirect, clientNonce: 'fw-9', type: 'text', content: '秘密' },
    })
    const result = await api('POST', '/messages/forward', {
      token: bob.accessToken,
      body: { messageIds: [msg.json.message.id], targetConversationIds: [targetGroup] },
    })
    expect(result.status).toBe(403)
  })

  it('目标会话被禁言时转发被拒绝', async () => {
    const muted = await api('PATCH', `/conversations/${targetGroup}/members/${bob.user.id}`, {
      token: alice.accessToken,
      body: { muteUntil: Date.now() + 60 * 60 * 1000 },
    })
    expect(muted.status).toBe(200)

    const msg = await api<{ message: { id: string } }>('POST', '/messages', {
      token: alice.accessToken,
      body: { conversationId: sourceDirect, clientNonce: 'fw-10', type: 'text', content: '禁言测试' },
    })
    const result = await api('POST', '/messages/forward', {
      token: bob.accessToken,
      body: { messageIds: [msg.json.message.id], targetConversationIds: [targetGroup] },
    })
    expect(result.status).toBe(403)
    expect(result.json.error.code).toBe('FORBIDDEN')

    await api('PATCH', `/conversations/${targetGroup}/members/${bob.user.id}`, {
      token: alice.accessToken,
      body: { muteUntil: null },
    })
  })

  it('每条转发消息都在变更日志里留痕', async () => {
    const { getDb, one } = await import('../src/db')
    const db = getDb()
    const mismatch = (await one<{ c: number }>(
      db,
      `SELECT COUNT(*) AS c FROM messages m
         WHERE m.conversation_id = ? AND NOT EXISTS (
           SELECT 1 FROM sync_change_log cl WHERE cl.entity = 'message' AND cl.entity_id = m.id
         )`,
      [targetGroup],
    ))!
    expect(mismatch.c).toBe(0)
  })
})
