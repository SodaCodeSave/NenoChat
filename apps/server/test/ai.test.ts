import { testDatabaseUrl } from './helpers/pg'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

const dataDir = mkdtempSync(path.join(tmpdir(), 'nenochat-ai-'))
process.env.NODE_ENV = 'test'
process.env.DATA_DIR = dataDir
process.env.DATABASE_URL = testDatabaseUrl(import.meta.url)
process.env.LOG_LEVEL = 'fatal'
process.env.JWT_SECRET = 'test-jwt-secret-at-least-16-chars'
process.env.SECRET_KEY = 'test-aes-secret-at-least-16-chars'

let app: FastifyInstance
let token = ''

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

beforeAll(async () => {
  const { buildApp } = await import('../src/app')
  app = await buildApp()
  await app.ready()

  const reg = await api<{ tokens: { accessToken: string } }>('POST', '/auth/register', {
    body: { username: 'ai_user', password: 'pass12345', displayName: 'AI 用户', device: device('dev-ai') },
  })
  token = reg.json.tokens.accessToken
})

afterAll(async () => {
  await app.close()
  const { closeDb } = await import('../src/db')
  closeDb()
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
})

describe('AI 服务商与角色', () => {
  it('API Key 一律加密存储，只返回掩码', async () => {
    const created = await api<{ provider: { id: string; apiKeyMasked: string | null } }>('POST', '/ai/providers', {
      token,
      body: {
        name: '云端中转',
        baseUrl: 'https://example.com/v1',
        model: 'gpt-4o-mini',
        apiKey: 'sk-server-side-secret-key',
      },
    })
    expect(created.status).toBe(200)
    expect(created.json.provider.apiKeyMasked).toMatch(/^sk-s\*+[\w-]{4}$/)
    expect(JSON.stringify(created.json)).not.toContain('sk-server-side-secret-key')
  })

  it('创建角色并校验必填字段', async () => {
    const ok = await api<{ persona: { id: string; name: string; replyStyle: string } }>('POST', '/ai/personas', {
      token,
      body: { name: '小禾', systemPrompt: '你是一个温柔的朋友。', replyStyle: 'chatty' },
    })
    expect(ok.status).toBe(200)
    expect(ok.json.persona.name).toBe('小禾')

    const bad = await api('POST', '/ai/personas', { token, body: { name: '', systemPrompt: '' } })
    expect(bad.status).toBe(400)
    expect(bad.json.error.code).toBe('VALIDATION')
  })
})

describe('AI 会话', () => {
  it('同一角色重复打开会复用同一个会话，并写入开场白', async () => {
    const persona = await api<{ persona: { id: string } }>('POST', '/ai/personas', {
      token,
      body: { name: '开场测试', systemPrompt: '你是朋友。', greeting: '在吗？' },
    })
    const provider = await api<{ provider: { id: string } }>('POST', '/ai/providers', {
      token,
      body: {
        name: 'p1',
        baseUrl: 'https://example.com/v1',
        model: 'gpt-4o-mini',
        apiKey: 'sk-x',
        keyLocation: 'local',
      },
    })

    const first = await api<{ conversation: { id: string; type: string; name: string } }>(
      'POST',
      '/ai/conversations',
      { token, body: { personaId: persona.json.persona.id, providerId: provider.json.provider.id } },
    )
    expect(first.status).toBe(200)
    expect(first.json.conversation.type).toBe('ai')
    expect(first.json.conversation.name).toBe('开场测试')

    const second = await api<{ conversation: { id: string } }>('POST', '/ai/conversations', {
      token,
      body: { personaId: persona.json.persona.id },
    })
    expect(second.json.conversation.id).toBe(first.json.conversation.id)

    const messages = await api<{ messages: Array<{ content: string; senderType: string }> }>(
      'GET',
      `/conversations/${first.json.conversation.id}/messages?limit=20`,
      { token },
    )
    expect(messages.json.messages.some((m) => m.senderType === 'ai' && m.content === '在吗？')).toBe(true)
  })

  it('AI 分条消息带 generationId 与 index，便于前端合并渲染', async () => {
    const persona = await api<{ persona: { id: string } }>('POST', '/ai/personas', {
      token,
      body: { name: '分条测试', systemPrompt: '你是朋友。' },
    })
    const provider = await api<{ provider: { id: string } }>('POST', '/ai/providers', {
      token,
      body: { name: 'p2', baseUrl: 'https://example.com/v1', model: 'm' },
    })
    const conv = await api<{ conversation: { id: string } }>('POST', '/ai/conversations', {
      token,
      body: { personaId: persona.json.persona.id, providerId: provider.json.provider.id },
    })
    const conversationId = conv.json.conversation.id

    for (let index = 0; index < 3; index++) {
      const res = await api<{ message: { aiGenerationId: string; aiIndex: number; senderType: string } }>(
        'POST',
        `/ai/conversations/${conversationId}/messages`,
        {
          token,
          body: { generationId: 'gen-test', index, content: `第 ${index + 1} 段` },
        },
      )
      expect(res.status).toBe(200)
      expect(res.json.message.aiGenerationId).toBe('gen-test')
      expect(res.json.message.aiIndex).toBe(index)
      expect(res.json.message.senderType).toBe('ai')
    }
  })

  it('记忆可写入、可读取、可删除事实', async () => {
    const persona = await api<{ persona: { id: string } }>('POST', '/ai/personas', {
      token,
      body: { name: '记忆测试', systemPrompt: '你是朋友。' },
    })
    const conv = await api<{ conversation: { id: string } }>('POST', '/ai/conversations', {
      token,
      body: { personaId: persona.json.persona.id },
    })
    const conversationId = conv.json.conversation.id

    const write = await api('POST', `/ai/conversations/${conversationId}/memory`, {
      token,
      body: {
        summary: { fromSeq: 0, toSeq: 10, text: '对方在准备一个项目，最近常喝美式。' },
        facts: [
          { subject: 'user', key: 'drink', value: '美式咖啡', confidence: 0.9 },
          { subject: 'relation', key: 'project', value: '在做聊天软件', confidence: 0.8 },
        ],
      },
    })
    expect(write.status).toBe(200)

    const memory = await api<{ summaries: unknown[]; facts: Array<{ id: string; key: string }> }>(
      'GET',
      `/ai/conversations/${conversationId}/memory`,
      { token },
    )
    expect(memory.json.summaries).toHaveLength(1)
    expect(memory.json.facts).toHaveLength(2)

    const factId = memory.json.facts.find((f) => f.key === 'drink')!.id
    const removed = await api('DELETE', `/ai/conversations/${conversationId}/memory/facts/${factId}`, { token })
    expect(removed.status).toBe(200)

    const after = await api<{ facts: unknown[] }>('GET', `/ai/conversations/${conversationId}/memory`, { token })
    expect(after.json.facts).toHaveLength(1)
  })

  it('没有配置 API Key 的服务商调用服务端生成会被拒绝', async () => {
    const persona = await api<{ persona: { id: string } }>('POST', '/ai/personas', {
      token,
      body: { name: '拒绝测试', systemPrompt: '你是朋友。' },
    })
    const provider = await api<{ provider: { id: string } }>('POST', '/ai/providers', {
      token,
      body: { name: 'p3', baseUrl: 'https://example.com/v1', model: 'm' },
    })
    const conv = await api<{ conversation: { id: string } }>('POST', '/ai/conversations', {
      token,
      body: { personaId: persona.json.persona.id, providerId: provider.json.provider.id },
    })

    const res = await api('POST', '/ai/generations', {
      token,
      body: {
        conversationId: conv.json.conversation.id,
        content: '在吗',
        clientNonce: 'n-1',
        providerId: provider.json.provider.id,
      },
    })
    expect(res.status).toBe(502)
  })
})

describe('角色自动进入消息与通讯录', () => {
  it('创建角色即自动生成 AI 会话，名称与头像取自角色', async () => {
    const created = await api<{ persona: { id: string; name: string; inContacts: boolean } }>(
      'POST',
      '/ai/personas',
      {
        token,
        body: {
          name: '自动上架',
          systemPrompt: '你是朋友。',
          avatarUrl: '/files/avatars/aa/bb/x.png',
          interests: ['咖啡', '猫'],
          card: '你住在一间临街旧书店的楼上。',
        },
      },
    )
    expect(created.status).toBe(200)
    expect(created.json.persona.inContacts).toBe(true)

    const list = await api<{ conversations: Array<{ id: string; type: string; name: string; avatarUrl: string | null; aiPersonaId: string | null }> }>(
      'GET',
      '/conversations',
      { token },
    )
    const found = list.json.conversations.find((c) => c.aiPersonaId === created.json.persona.id)
    expect(found).toBeTruthy()
    expect(found!.type).toBe('ai')
    expect(found!.name).toBe('自动上架')
    expect(found!.avatarUrl).toBe('/files/avatars/aa/bb/x.png')
  })

  it('兴趣与角色卡可往返读写', async () => {
    const created = await api<{ persona: { id: string } }>('POST', '/ai/personas', {
      token,
      body: {
        name: '设定测试',
        systemPrompt: '你是朋友。',
        interests: ['独立音乐', '深夜写代码'],
        card: '你有一只叫年糕的橘猫。',
        cardFilename: 'card.md',
      },
    })
    const list = await api<{ personas: Array<{ id: string; interests: string[]; card: string | null; cardFilename: string | null }> }>(
      'GET',
      '/ai/personas',
      { token },
    )
    const found = list.json.personas.find((p) => p.id === created.json.persona.id)!
    expect(found.interests).toEqual(['独立音乐', '深夜写代码'])
    expect(found.card).toContain('年糕')
    expect(found.cardFilename).toBe('card.md')
  })

  it('inContacts=false 不建会话', async () => {
    const created = await api<{ persona: { id: string } }>('POST', '/ai/personas', {
      token,
      body: { name: '隐身角色', systemPrompt: '你是朋友。', inContacts: false },
    })
    const list = await api<{ conversations: Array<{ aiPersonaId: string | null }> }>('GET', '/conversations', {
      token,
    })
    expect(list.json.conversations.some((c) => c.aiPersonaId === created.json.persona.id)).toBe(false)
  })

  it('改名换头像会同步到已有会话', async () => {
    const created = await api<{ persona: { id: string } }>('POST', '/ai/personas', {
      token,
      body: { name: '改名前', systemPrompt: '你是朋友。' },
    })
    const before = await api<{ conversations: Array<{ id: string; aiPersonaId: string | null }> }>(
      'GET',
      '/conversations',
      { token },
    )
    const conversationId = before.json.conversations.find((c) => c.aiPersonaId === created.json.persona.id)!.id

    await api('PATCH', `/ai/personas/${created.json.persona.id}`, {
      token,
      body: { name: '改名后', avatarUrl: '/files/avatars/cc/dd/y.png' },
    })

    const after = await api<{ conversations: Array<{ id: string; name: string; avatarUrl: string | null }> }>(
      'GET',
      '/conversations',
      { token },
    )
    const updated = after.json.conversations.find((c) => c.id === conversationId)!
    expect(updated.name).toBe('改名后')
    expect(updated.avatarUrl).toBe('/files/avatars/cc/dd/y.png')
  })

  it('删除角色后会话从列表消失', async () => {
    const created = await api<{ persona: { id: string } }>('POST', '/ai/personas', {
      token,
      body: { name: '待删除', systemPrompt: '你是朋友。' },
    })

    const del = await api('DELETE', `/ai/personas/${created.json.persona.id}`, { token })
    expect(del.status).toBe(200)

    const list = await api<{ conversations: Array<{ aiPersonaId: string | null }> }>('GET', '/conversations', {
      token,
    })
    expect(list.json.conversations.some((c) => c.aiPersonaId === created.json.persona.id)).toBe(false)
  })

  it('AI 消息带 personaId，同 nonce 只落一条', async () => {
    const created = await api<{ persona: { id: string } }>('POST', '/ai/personas', {
      token,
      body: { name: '身份测试', systemPrompt: '你是朋友。' },
    })
    const conv = await api<{ conversation: { id: string } }>('POST', '/ai/conversations', {
      token,
      body: { personaId: created.json.persona.id },
    })
    const conversationId = conv.json.conversation.id

    const body = {
      generationId: 'gen-identity',
      index: 0,
      content: '在的',
      clientNonce: 'nonce-identity-1',
    }
    const first = await api<{ message: { id: string; meta: { ai?: { personaId?: string } } } }>(
      'POST',
      `/ai/conversations/${conversationId}/messages`,
      { token, body },
    )
    expect(first.json.message.meta.ai?.personaId).toBe(created.json.persona.id)

    const second = await api<{ message: { id: string } }>(
      'POST',
      `/ai/conversations/${conversationId}/messages`,
      { token, body },
    )
    expect(second.json.message.id).toBe(first.json.message.id)

    const page = await api<{ messages: Array<{ id: string }> }>(
      'GET',
      `/conversations/${conversationId}/messages?limit=50`,
      { token },
    )
    expect(page.json.messages.filter((m) => m.id === first.json.message.id)).toHaveLength(1)
  })
})
