import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

const dataDir = mkdtempSync(path.join(tmpdir(), 'nenochat-group-ai-'))
process.env.NODE_ENV = 'test'
process.env.DATA_DIR = dataDir
process.env.LOG_LEVEL = 'fatal'
process.env.JWT_SECRET = 'test-jwt-secret-at-least-16-chars'
process.env.SECRET_KEY = 'test-aes-secret-at-least-16-chars'

let app: FastifyInstance
let upstream: Server
let upstreamPort = 0

let aliceToken = ''
let aliceId = ''
let bobToken = ''
let bobId = ''
let personaId = ''
let botUserId = ''
let groupId = ''

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => silentLog,
  level: 'fatal',
} as never

function device(id: string) {
  return { id, name: `设备-${id}`, platform: 'win32', appVersion: '0.1.0' }
}

async function api<T = any>(
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
): Promise<{ status: number; json: T }> {
  const res = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  })
  return { status: res.statusCode, json: res.json() as T }
}

interface WireMessage {
  id: string
  senderId: string | null
  senderType: string
  content: string
  createdAt: number
  meta?: { ai?: { personaId?: string; proactive?: boolean } }
}

async function listMessages(): Promise<WireMessage[]> {
  const res = await api<{ messages: WireMessage[] }>(
    bobToken,
    'GET',
    `/conversations/${groupId}/messages?limit=50`,
  )
  expect(res.status).toBe(200)
  return res.json.messages
}

async function waitForAiMessages(min: number, timeoutMs = 5_000): Promise<WireMessage[]> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const aiMessages = (await listMessages()).filter((message) => message.senderType === 'ai')
    if (aiMessages.length >= min) return aiMessages
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  throw new Error('等待 AI 群消息超时')
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    if (!req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '我在听一张老唱片，正好也想问你。' } }],
          usage: { prompt_tokens: 10, completion_tokens: 12 },
        }),
      )
    })
  })

  await new Promise<void>((resolve) => {
    upstream.listen(0, '127.0.0.1', () => {
      const address = upstream.address()
      upstreamPort = typeof address === 'object' && address ? address.port : 0
      resolve()
    })
  })

  const { buildApp } = await import('../src/app')
  app = await buildApp()
  await app.ready()

  const alice = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      username: 'alice_group',
      password: 'pass12345',
      displayName: 'Alice',
      device: device('dev-alice'),
    }),
  })
  const aliceSession = alice.json() as { user: { id: string }; tokens: { accessToken: string } }
  aliceToken = aliceSession.tokens.accessToken
  aliceId = aliceSession.user.id

  const bob = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      username: 'bob_group',
      password: 'pass12345',
      displayName: 'Bob',
      device: device('dev-bob'),
    }),
  })
  const bobSession = bob.json() as { user: { id: string }; tokens: { accessToken: string } }
  bobToken = bobSession.tokens.accessToken
  bobId = bobSession.user.id

  const provider = await api<{ provider: { id: string } }>(aliceToken, 'POST', '/ai/providers', {
    name: 'mock',
    baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    model: 'mock-model',
    apiKey: 'sk-mock-key-123456',
    keyLocation: 'server',
  })
  expect(provider.status).toBe(200)

  const persona = await api<{ persona: { id: string; userId: string } }>(
    aliceToken,
    'POST',
    '/ai/personas',
    {
      name: '小禾',
      systemPrompt: '你是群里的一员，话不多。',
      interests: ['独立音乐'],
      providerId: provider.json.provider.id,
    },
  )
  expect(persona.status).toBe(200)
  personaId = persona.json.persona.id
  botUserId = persona.json.persona.userId
  expect(botUserId).toBeTruthy()
})

afterAll(async () => {
  await app.close()
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
  const { closeDb } = await import('../src/db')
  closeDb()
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
})

describe('群聊拉 AI', () => {
  it('建群时可以把自己的 AI 角色一起拉进来', async () => {
    const created = await api<{
      conversation: { id: string; type: string }
    }>(aliceToken, 'POST', '/conversations', {
      type: 'group',
      name: '听歌群',
      memberIds: [bobId, botUserId],
    })
    expect(created.status).toBe(200)
    groupId = created.json.conversation.id

    const detail = await api<{ members: Array<{ userId: string }> }>(
      aliceToken,
      'GET',
      `/conversations/${groupId}`,
    )
    const memberIds = detail.json.members.map((member) => member.userId)
    expect(memberIds).toContain(botUserId)
    expect(memberIds).toContain(bobId)
  })

  it('别人不能把不属于自己的 AI 角色拉进群', async () => {
    const created = await api<{ conversation: { id: string } }>(bobToken, 'POST', '/conversations', {
      type: 'group',
      name: 'Bob 的群',
      memberIds: [],
    })
    const target = created.json.conversation.id

    const attempt = await api(bobToken, 'POST', `/conversations/${target}/members`, {
      userIds: [botUserId],
    })
    expect(attempt.status).toBe(403)
  })

  it('被点名时 AI 在群里回复，并按角色身份展示', async () => {
    const sent = await api(bobToken, 'POST', '/messages', {
      conversationId: groupId,
      clientNonce: 'group-mention-1',
      type: 'text',
      content: '@小禾 你今天听什么歌？',
    })
    expect(sent.status).toBe(200)

    const aiMessages = await waitForAiMessages(1)
    expect(aiMessages[0]!.senderId).toBe(botUserId)
    expect(aiMessages[0]!.content).toContain('唱片')
    expect(aiMessages[0]!.meta?.ai?.personaId).toBe(personaId)
  })

  it('冷却期内连续点名也不会刷屏', async () => {
    await api(bobToken, 'POST', '/messages', {
      conversationId: groupId,
      clientNonce: 'group-mention-2',
      type: 'text',
      content: '@小禾 再来一首？',
    })
    await new Promise((resolve) => setTimeout(resolve, 400))

    const aiMessages = (await listMessages()).filter(
      (message) => message.senderType === 'ai' && !message.meta?.ai?.proactive,
    )
    expect(aiMessages).toHaveLength(1)
  })
})

describe('群聊主动开口', () => {
  it('安静够久后角色会自己起个话题', async () => {
    const { getDb } = await import('../src/db')
    const { scanGroupAutonomyOnce } = await import('../src/services/group-ai-service')
    const db = getDb() as unknown as import('better-sqlite3').Database

    // 把群里的消息整体往前挪，制造「安静 3 小时」的局面
    db.prepare('UPDATE messages SET created_at = created_at - ? WHERE conversation_id = ?').run(
      3 * 3_600_000,
      groupId,
    )

    await scanGroupAutonomyOnce(db, silentLog, { random: () => 0 })

    const logs = db
      .prepare("SELECT status FROM ai_group_log WHERE conversation_id = ? AND kind = 'autonomy'")
      .all(groupId) as Array<{ status: string }>
    expect(logs).toHaveLength(1)
    expect(logs[0]!.status).toBe('sent')

    const proactive = (await listMessages()).filter((message) => message.meta?.ai?.proactive)
    expect(proactive.length).toBeGreaterThan(0)
    expect(proactive[0]!.senderId).toBe(botUserId)

    // 再扫一次不会因为同一格重复发
    await scanGroupAutonomyOnce(db, silentLog, { random: () => 0 })
    const again = db
      .prepare("SELECT COUNT(*) AS c FROM ai_group_log WHERE conversation_id = ? AND kind = 'autonomy'")
      .get(groupId) as { c: number }
    expect(again.c).toBe(1)
  })
})

describe('通讯录与好友', () => {
  it('AI 角色建好后自动进通讯录，和真人同一个列表', async () => {
    const contacts = await api<{ friends: Array<{ contactUserId: string; relation: string }> }>(
      aliceToken,
      'GET',
      '/contacts',
    )
    expect(contacts.status).toBe(200)
    const friendIds = contacts.json.friends.map((contact) => contact.contactUserId)
    expect(friendIds).toContain(botUserId)
  })

  it('全文搜索不会把影子账号搜出来', async () => {
    const search = await api<{ users: Array<{ id: string }> }>(
      bobToken,
      'GET',
      '/users/search?q=%E5%B0%8F%E7%A6%BE',
    )
    expect(search.status).toBe(200)
    expect(search.json.users.some((user) => user.id === botUserId)).toBe(false)
  })

  it('好友申请、同意后双方通讯录都出现对方', async () => {
    const request = await api(bobToken, 'POST', '/contacts/requests', {
      userId: aliceId,
      message: '我是 Bob',
    })
    expect(request.status).toBe(200)

    const incoming = await api<{ incoming: Array<{ contactUserId: string; requestMessage: string }> }>(
      aliceToken,
      'GET',
      '/contacts',
    )
    expect(incoming.json.incoming.some((item) => item.contactUserId === bobId)).toBe(true)

    const accepted = await api(aliceToken, 'POST', `/contacts/requests/${bobId}/accept`)
    expect(accepted.status).toBe(200)

    const aliceContacts = await api<{ friends: Array<{ contactUserId: string }> }>(
      aliceToken,
      'GET',
      '/contacts',
    )
    const bobContacts = await api<{ friends: Array<{ contactUserId: string }> }>(
      bobToken,
      'GET',
      '/contacts',
    )
    expect(aliceContacts.json.friends.some((item) => item.contactUserId === bobId)).toBe(true)
    expect(bobContacts.json.friends.some((item) => item.contactUserId === aliceId)).toBe(true)
  })
})

describe('群管理', () => {
  it('群主可以转让群主，新群主可以解散', async () => {
    const transferred = await api<{ previous: { role: string }; next: { role: string } }>(
      aliceToken,
      'POST',
      `/conversations/${groupId}/transfer`,
      { userId: bobId },
    )
    expect(transferred.status).toBe(200)
    expect(transferred.json.previous.role).toBe('admin')
    expect(transferred.json.next.role).toBe('owner')

    const dissolved = await api(bobToken, 'DELETE', `/conversations/${groupId}`)
    expect(dissolved.status).toBe(200)

    const list = await api<{ conversations: Array<{ id: string }> }>(aliceToken, 'GET', '/conversations')
    expect(list.json.conversations.some((item) => item.id === groupId)).toBe(false)
  })
})
