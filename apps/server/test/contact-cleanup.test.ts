import { testDatabaseUrl } from './helpers/pg'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

const dataDir = mkdtempSync(path.join(tmpdir(), 'nenochat-contact-cleanup-'))
process.env.NODE_ENV = 'test'
process.env.DATA_DIR = dataDir
process.env.DATABASE_URL = testDatabaseUrl(import.meta.url)
process.env.LOG_LEVEL = 'fatal'
process.env.JWT_SECRET = 'test-jwt-secret-at-least-16-chars'
process.env.SECRET_KEY = 'test-aes-secret-at-least-16-chars'

let app: FastifyInstance
let alice = ''
let aliceId = ''
let bob = ''
let bobId = ''

interface ConversationSummary {
  id: string
  type: string
  partnerId?: string | null
  partnerName?: string | null
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

async function conversationIds(token: string): Promise<string[]> {
  const res = await api<{ conversations: ConversationSummary[] }>('GET', '/conversations', { token })
  return res.json.conversations.map((item) => item.id)
}

beforeAll(async () => {
  const { buildApp } = await import('../src/app')
  app = await buildApp()
  await app.ready()

  const a = await api<{ user: { id: string }; tokens: { accessToken: string } }>(
    'POST',
    '/auth/register',
    {
      body: { username: 'cleanup_alice', password: 'pass12345', displayName: '爱丽丝', device: device('dev-a') },
    },
  )
  alice = a.json.tokens.accessToken
  aliceId = a.json.user.id

  const b = await api<{ user: { id: string }; tokens: { accessToken: string } }>(
    'POST',
    '/auth/register',
    {
      body: { username: 'cleanup_bob', password: 'pass12345', displayName: '鲍勃', device: device('dev-b') },
    },
  )
  bob = b.json.tokens.accessToken
  bobId = b.json.user.id
})

afterAll(async () => {
  await app.close()
  const { closeDb } = await import('../src/db')
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('私聊单侧清理', () => {
  it('删除临时对话仅清除自己这一侧，对端仍保留历史', async () => {
    const created = await api<{ conversation: { id: string } }>('POST', '/conversations', {
      token: alice,
      body: { type: 'direct', targetUserId: bobId },
    })
    expect(created.status).toBe(200)
    const conversationId = created.json.conversation.id

    await api('POST', '/messages', {
      token: alice,
      body: {
        conversationId,
        clientNonce: 'cleanup-temp-1',
        type: 'text',
        content: '临时消息',
      },
    })

    const removed = await api('DELETE', `/conversations/${conversationId}/for-me`, { token: alice })
    expect(removed.status).toBe(200)

    expect(await conversationIds(alice)).not.toContain(conversationId)
    const bobIds = await conversationIds(bob)
    expect(bobIds).toContain(conversationId)

    const detail = await api<{ conversations: ConversationSummary[] }>('GET', '/conversations', { token: bob })
    const kept = detail.json.conversations.find((item) => item.id === conversationId)
    expect(kept?.partnerId).toBe(aliceId)
    expect(kept?.partnerName).toBe('爱丽丝')

    const history = await api<{ messages: Array<{ content: string }> }>(
      'GET',
      `/conversations/${conversationId}/messages`,
      { token: bob },
    )
    expect(history.json.messages.some((item) => item.content === '临时消息')).toBe(true)

    const denied = await api('GET', `/conversations/${conversationId}/messages`, { token: alice })
    expect(denied.status).toBe(403)
  })

  it('删除好友仅清除自己这侧聊天，重新私聊生成全新会话', async () => {
    const created = await api<{ conversation: { id: string } }>('POST', '/conversations', {
      token: alice,
      body: { type: 'direct', targetUserId: bobId },
    })
    const oldId = created.json.conversation.id

    await api('POST', '/messages', {
      token: alice,
      body: {
        conversationId: oldId,
        clientNonce: 'cleanup-friend-1',
        type: 'text',
        content: '好友消息',
      },
    })

    const request = await api('POST', '/contacts/requests', {
      token: alice,
      body: { userId: bobId, message: '加个好友' },
    })
    expect(request.status).toBe(200)
    const accepted = await api('POST', `/contacts/requests/${aliceId}/accept`, { token: bob })
    expect(accepted.status).toBe(200)

    const removed = await api('DELETE', `/contacts/${bobId}`, { token: alice })
    expect(removed.status).toBe(200)

    const aliceContacts = await api<{ friends: unknown[] }>('GET', '/contacts', { token: alice })
    const bobContacts = await api<{ friends: unknown[] }>('GET', '/contacts', { token: bob })
    expect(aliceContacts.json.friends).toHaveLength(0)
    expect(bobContacts.json.friends).toHaveLength(0)

    expect(await conversationIds(alice)).not.toContain(oldId)
    expect(await conversationIds(bob)).toContain(oldId)

    const bobHistory = await api<{ messages: Array<{ content: string }> }>(
      'GET',
      `/conversations/${oldId}/messages`,
      { token: bob },
    )
    expect(bobHistory.json.messages.some((item) => item.content === '好友消息')).toBe(true)

    const changes = await api<{
      changes: Array<{ entity: string; entityId: string; op: string; payload: { id?: string } }>
    }>('GET', '/sync/changes?since=0', { token: alice })
    expect(
      changes.json.changes.some(
        (change) => change.entity === 'conversation' && change.op === 'delete' && change.payload.id === oldId,
      ),
    ).toBe(true)

    const reopened = await api<{ conversation: { id: string } }>('POST', '/conversations', {
      token: alice,
      body: { type: 'direct', targetUserId: bobId },
    })
    expect(reopened.json.conversation.id).not.toBe(oldId)

    const freshHistory = await api<{ messages: unknown[] }>(
      'GET',
      `/conversations/${reopened.json.conversation.id}/messages`,
      { token: alice },
    )
    expect(freshHistory.json.messages).toHaveLength(0)
  })
})
