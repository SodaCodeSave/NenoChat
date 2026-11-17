import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

const dataDir = mkdtempSync(path.join(tmpdir(), 'nenochat-social-'))
process.env.NODE_ENV = 'test'
process.env.DATA_DIR = dataDir
process.env.LOG_LEVEL = 'fatal'
process.env.JWT_SECRET = 'test-jwt-secret-at-least-16-chars'
process.env.SECRET_KEY = 'test-aes-secret-at-least-16-chars'

let app: FastifyInstance
let alice = ''
let bob = ''
let bobId = ''
let conversationId = ''

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

/** 只满足魔数校验的最小 PNG */
function pngBuffer(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(24, 0x02),
  ])
}

async function uploadSticker(token: string): Promise<string> {
  const boundary = '----nenochatStickerBoundary'
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="sticker.png"\r\n` +
      `Content-Type: image/png\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/files?kind=sticker',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([head, pngBuffer(), tail]),
  })
  expect(res.statusCode).toBe(200)
  return (res.json() as { attachment: { id: string } }).attachment.id
}

beforeAll(async () => {
  const { buildApp } = await import('../src/app')
  app = await buildApp()
  await app.ready()

  const a = await api<{ tokens: { accessToken: string } }>('POST', '/auth/register', {
    body: { username: 'alice_social', password: 'pass12345', displayName: '爱丽丝', device: device('dev-a') },
  })
  alice = a.json.tokens.accessToken

  const b = await api<{ user: { id: string }; tokens: { accessToken: string } }>('POST', '/auth/register', {
    body: { username: 'bob_social', password: 'pass12345', displayName: '鲍勃', device: device('dev-b') },
  })
  bob = b.json.tokens.accessToken
  bobId = b.json.user.id

  const conv = await api<{ conversation: { id: string } }>('POST', '/conversations', {
    token: alice,
    body: { type: 'direct', targetUserId: bobId },
  })
  conversationId = conv.json.conversation.id

  await api('POST', '/messages', {
    token: alice,
    body: {
      conversationId,
      clientNonce: 'search-nonce-1',
      type: 'text',
      content: '记得买牛奶和面包',
    },
  })
})

afterAll(async () => {
  await app.close()
  const { closeDb } = await import('../src/db')
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('动态空间', () => {
  let postId = ''

  it('发布动态并出现在信息流里', async () => {
    const res = await api<{ post: { id: string; content: string; author: { displayName: string } } }>(
      'POST',
      '/posts',
      { token: alice, body: { content: '今天去了海边', attachmentIds: [] } },
    )
    expect(res.status).toBe(200)
    expect(res.json.post.content).toBe('今天去了海边')
    expect(res.json.post.author.displayName).toBe('爱丽丝')
    postId = res.json.post.id

    const feed = await api<{ posts: Array<{ id: string }> }>('GET', '/posts', { token: bob })
    expect(feed.json.posts.some((p) => p.id === postId)).toBe(true)
  })

  it('空内容且无配图被拒绝', async () => {
    const res = await api('POST', '/posts', { token: alice, body: { content: '   ', attachmentIds: [] } })
    expect(res.status).toBe(400)
  })

  it('点赞是幂等的目标状态而不是取反', async () => {
    const first = await api<{ liked: boolean; likeCount: number }>('POST', `/posts/${postId}/like`, {
      token: bob,
      body: { liked: true },
    })
    expect(first.json).toEqual({ liked: true, likeCount: 1 })

    const again = await api<{ liked: boolean; likeCount: number }>('POST', `/posts/${postId}/like`, {
      token: bob,
      body: { liked: true },
    })
    expect(again.json).toEqual({ liked: true, likeCount: 1 })

    const off = await api<{ liked: boolean; likeCount: number }>('POST', `/posts/${postId}/like`, {
      token: bob,
      body: { liked: false },
    })
    expect(off.json).toEqual({ liked: false, likeCount: 0 })
  })

  it('评论写入后动态的评论数同步更新', async () => {
    const created = await api<{ comment: { id: string; content: string; authorId: string } }>(
      'POST',
      `/posts/${postId}/comments`,
      { token: bob, body: { content: '照片呢' } },
    )
    expect(created.status).toBe(200)

    const list = await api<{ comments: Array<{ content: string }> }>('GET', `/posts/${postId}/comments`, {
      token: alice,
    })
    expect(list.json.comments.map((c) => c.content)).toContain('照片呢')

    const feed = await api<{ posts: Array<{ id: string; commentCount: number }> }>('GET', '/posts', {
      token: alice,
    })
    const target = feed.json.posts.find((p) => p.id === postId)
    expect(target?.commentCount).toBe(1)
  })

  it('只有作者能删除动态', async () => {
    const denied = await api('DELETE', `/posts/${postId}`, { token: bob })
    expect(denied.status).toBe(403)

    const ok = await api('DELETE', `/posts/${postId}`, { token: alice })
    expect(ok.status).toBe(200)

    const feed = await api<{ posts: Array<{ id: string }> }>('GET', '/posts', { token: alice })
    expect(feed.json.posts.some((p) => p.id === postId)).toBe(false)
  })
})

describe('全局搜索', () => {
  it('中文三字以上走 FTS，能找到会话消息', async () => {
    const res = await api<{ messages: Array<{ message: { content: string }; conversationId: string }> }>(
      'GET',
      `/search?q=${encodeURIComponent('牛奶和面包')}`,
      { token: bob },
    )
    expect(res.json.messages.length).toBeGreaterThan(0)
    expect(res.json.messages[0]!.message.content).toContain('牛奶')
    expect(res.json.messages[0]!.conversationId).toBe(conversationId)
  })

  it('搜索结果可定位上下文（跳转不会落在空白页）', async () => {
    const hits = await api<{ messages: Array<{ message: { id: string; seq: number } }> }>(
      'GET',
      `/search?q=${encodeURIComponent('牛奶和面包')}`,
      { token: bob },
    )
    const target = hits.json.messages[0]!.message

    const around = await api<{ messages: Array<{ id: string; seq: number }> }>(
      'GET',
      `/conversations/${conversationId}/messages/around/${target.id}`,
      { token: bob },
    )
    expect(around.status).toBe(200)
    expect(around.json.messages.some((m) => m.id === target.id)).toBe(true)

    const seqs = around.json.messages.map((m) => m.seq)
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
  })

  it('短词回退 LIKE 也能命中', async () => {
    const res = await api<{ messages: Array<{ message: { content: string } }> }>(
      'GET',
      `/search?q=${encodeURIComponent('牛奶')}`,
      { token: bob },
    )
    expect(res.json.messages.length).toBeGreaterThan(0)
  })

  it('非成员搜不到别人的私聊', async () => {
    const third = await api<{ tokens: { accessToken: string } }>('POST', '/auth/register', {
      body: { username: 'carol_social', password: 'pass12345', displayName: '卡罗', device: device('dev-c') },
    })
    const res = await api<{ messages: unknown[] }>('GET', `/search?q=${encodeURIComponent('牛奶和面包')}`, {
      token: third.json.tokens.accessToken,
    })
    expect(res.json.messages).toHaveLength(0)
  })

  it('能搜到用户与会话名', async () => {
    const users = await api<{ users: Array<{ displayName: string }> }>(
      'GET',
      `/search?q=${encodeURIComponent('鲍勃')}&scope=users`,
      { token: alice },
    )
    expect(users.json.users.some((u) => u.displayName === '鲍勃')).toBe(true)

    const group = await api<{ conversation: { id: string } }>('POST', '/conversations', {
      token: alice,
      body: { type: 'group', name: '周末旅行计划', memberIds: [bobId] },
    })
    const convs = await api<{ conversations: Array<{ id: string }> }>(
      'GET',
      `/search?q=${encodeURIComponent('旅行计划')}&scope=conversations`,
      { token: alice },
    )
    expect(convs.json.conversations.some((c) => c.id === group.json.conversation.id)).toBe(true)
  })

  it('撤回的消息从索引里消失', async () => {
    const sent = await api<{ message: { id: string } }>('POST', '/messages', {
      token: alice,
      body: {
        conversationId,
        clientNonce: 'search-nonce-recall',
        type: 'text',
        content: '这条要被撤回的关键字',
      },
    })
    const before = await api<{ messages: unknown[] }>('GET', `/search?q=${encodeURIComponent('要被撤回')}`, {
      token: alice,
    })
    expect(before.json.messages.length).toBe(1)

    await api('DELETE', `/messages/${sent.json.message.id}`, { token: alice })

    const after = await api<{ messages: unknown[] }>('GET', `/search?q=${encodeURIComponent('要被撤回')}`, {
      token: alice,
    })
    expect(after.json.messages).toHaveLength(0)
  })
})

describe('表情包', () => {
  it('首次读取自动建默认分组，可上传与删除表情', async () => {
    const initial = await api<{ packs: Array<{ pack: { id: string; name: string }; stickers: unknown[] }> }>(
      'GET',
      '/stickers/packs',
      { token: alice },
    )
    expect(initial.json.packs.length).toBeGreaterThan(0)
    const packId = initial.json.packs[0]!.pack.id

    const attachmentId = await uploadSticker(alice)
    const created = await api<{ sticker: { id: string; url: string; kind: string } }>('POST', '/stickers', {
      token: alice,
      body: { packId, attachmentId, keywords: ['开心'] },
    })
    expect(created.status).toBe(200)
    expect(created.json.sticker.url).toMatch(/^\/files\/stickers\//)
    expect(created.json.sticker.kind).toBe('image')

    const listed = await api<{ packs: Array<{ pack: { id: string }; stickers: Array<{ id: string }> }> }>(
      'GET',
      '/stickers/packs',
      { token: alice },
    )
    const pack = listed.json.packs.find((p) => p.pack.id === packId)
    expect(pack?.stickers.some((s) => s.id === created.json.sticker.id)).toBe(true)

    // 别人的表情删不掉
    const denied = await api('DELETE', `/stickers/${created.json.sticker.id}`, { token: bob })
    expect(denied.status).toBe(403)

    const removed = await api('DELETE', `/stickers/${created.json.sticker.id}`, { token: alice })
    expect(removed.status).toBe(200)
  })

  it('分组里还有表情时不允许删除', async () => {
    const packs = await api<{ packs: Array<{ pack: { id: string } }> }>('GET', '/stickers/packs', {
      token: bob,
    })
    const packId = packs.json.packs[0]!.pack.id
    const attachmentId = await uploadSticker(bob)
    await api('POST', '/stickers', { token: bob, body: { packId, attachmentId, keywords: [] } })

    const denied = await api('DELETE', `/stickers/packs/${packId}`, { token: bob })
    expect(denied.status).toBe(400)
  })
})
