import { testDatabaseUrl } from './helpers/pg'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

const dataDir = mkdtempSync(path.join(tmpdir(), 'nenochat-aidedupe-'))
process.env.NODE_ENV = 'test'
process.env.DATA_DIR = dataDir
process.env.DATABASE_URL = testDatabaseUrl(import.meta.url)
process.env.LOG_LEVEL = 'fatal'
process.env.JWT_SECRET = 'test-jwt-secret-at-least-16-chars'
process.env.SECRET_KEY = 'test-aes-secret-at-least-16-chars'

let app: FastifyInstance
let upstream: Server
let upstreamPort = 0
let token = ''
let conversationId = ''

/** 收集上游收到的 prompt，用来断言当前输入只出现一次 */
const capturedPrompts: Array<Array<{ role: string; content: string }>> = []

function device(id: string) {
  return { id, name: `设备-${id}`, platform: 'win32', appVersion: '0.1.0' }
}

async function api<T = any>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
): Promise<{ status: number; json: T }> {
  const res = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  })
  return { status: res.statusCode, json: res.json() as T }
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
      try {
        const body = JSON.parse(raw) as { messages: Array<{ role: string; content: string }> }
        capturedPrompts.push(body.messages)
      } catch {
        /* 上游报文体不合法时忽略 */
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '好呀，我在。' } }],
          usage: { prompt_tokens: 10, completion_tokens: 6 },
        }),
      )
    })
  })

  await new Promise<void>((resolve) => {
    upstream.listen(0, '127.0.0.1', () => {
      upstreamPort = (upstream.address() as { port: number }).port
      resolve()
    })
  })

  const { buildApp } = await import('../src/app')
  app = await buildApp()
  await app.ready()

  const reg = await api<{ tokens: { accessToken: string } }>('POST', '/auth/register', {
    username: 'dedupe_user',
    password: 'pass12345',
    displayName: '去重用户',
    device: device('dev-dedupe'),
  })
  if (!reg.json?.tokens) throw new Error(`注册失败: ${JSON.stringify(reg.json)}`)
  token = reg.json.tokens.accessToken

  const provider = await api<{ provider: { id: string } }>('POST', '/ai/providers', {
    name: '本地假上游',
    baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    model: 'test-model',
    apiKey: 'sk-test',
    keyLocation: 'server',
  })

  await api('POST', '/ai/personas', {
    name: '小禾',
    systemPrompt: '你是朋友。',
    providerId: provider.json.provider.id,
  })

  const list = await api<{ conversations: Array<{ id: string; type: string }> }>('GET', '/conversations')
  conversationId = list.json.conversations.find((item) => item.type === 'ai')!.id
})

afterAll(async () => {
  // 生成接口用 setTimeout 投递分条，等它们落库后再关库
  await new Promise((resolve) => setTimeout(resolve, 200))
  await app.close()
  const { closeDb } = await import('../src/db')
  closeDb()
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
  rmSync(dataDir, { recursive: true, force: true })
})

describe('AI 用户消息不会被写三遍', () => {
  it('客户端已发送 + 生成接口 nonce 不一致时，历史里仍只有一条', async () => {
    const content = '今天有点累，想聊聊'

    // 客户端正常发送（nonce A）
    const sent = await api<{ message: { id: string } }>('POST', '/messages', {
      conversationId,
      clientNonce: 'dedupe-nonce-a',
      type: 'text',
      content,
    })
    expect(sent.status).toBe(200)

    // 模拟旧客户端：生成时用了另一个 nonce（B），服务端按内容兜底去重
    const generated = await api('POST', '/ai/generations', {
      conversationId,
      content,
      clientNonce: 'dedupe-nonce-b',
      providerId: undefined,
    })
    expect(generated.status).toBe(200)

    const page = await api<{ messages: Array<{ senderType: string; content: string }> }>(
      'GET',
      `/conversations/${conversationId}/messages?limit=50`,
    )
    const sameContent = page.json.messages.filter(
      (message) => message.senderType === 'user' && message.content === content,
    )
    expect(sameContent).toHaveLength(1)
  })

  it('上游 prompt 里当前输入只出现一次', async () => {
    const content = '再说一句试试'

    await api('POST', '/messages', {
      conversationId,
      clientNonce: 'dedupe-nonce-c',
      type: 'text',
      content,
    })
    await api('POST', '/ai/generations', {
      conversationId,
      content,
      clientNonce: 'dedupe-nonce-c',
    })

    // 取最后一次上游调用
    const prompt = capturedPrompts[capturedPrompts.length - 1] ?? []
    const userTurns = prompt.filter((message) => message.role === 'user' && message.content === content)
    expect(userTurns).toHaveLength(1)
  })
})
