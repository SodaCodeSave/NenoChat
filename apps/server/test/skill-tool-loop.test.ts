import { testDatabaseUrl } from './helpers/pg'
import { startTestMcpServer } from './helpers/mcp-server'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

const dataDir = mkdtempSync(path.join(tmpdir(), 'nenochat-toolloop-'))
process.env.NODE_ENV = 'test'
process.env.DATA_DIR = dataDir
process.env.DATABASE_URL = testDatabaseUrl(import.meta.url)
process.env.LOG_LEVEL = 'fatal'
process.env.JWT_SECRET = 'test-jwt-secret-at-least-16-chars'
process.env.SECRET_KEY = 'test-aes-secret-at-least-16-chars'

let app: FastifyInstance
let token = ''
let upstream: ReturnType<typeof import('node:http').createServer> | null = null
let upstreamPort = 0
let mcpPort = 0
let closeMcp: (() => Promise<void>) | null = null
let conversationId = ''

/** 上游收到的完整请求体：断言 tools 字段与消息轮次 */
const capturedRequests: Array<{
  messages: Array<{ role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: unknown }>
  tools?: Array<{ type: string; function: { name: string } }>
}> = []

/** 上游按顺序回放的响应脚本；耗尽后回普通文本 */
const script: Array<unknown> = []

interface UpstreamDef {
  type: 'function'
  function: { name: string; arguments?: string }
}

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

/** 生成接口返回后分条还在 setTimeout 里投递，轮询等 AI 回复落库 */
async function waitForAiReply(keyword: string, timeoutMs = 4000): Promise<{ content: string } | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const page = await api<{ messages: Array<{ senderType: string; content: string }> }>(
      'GET',
      `/conversations/${conversationId}/messages?limit=50`,
    )
    const hit = page.json.messages.find((m) => m.senderType === 'ai' && m.content.includes(keyword))
    if (hit) return hit
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return null
}

beforeAll(async () => {
  const mcp = await startTestMcpServer()
  mcpPort = mcp.port
  closeMcp = mcp.close

  upstream = (
    await import('node:http')
  ).createServer((req, res) => {
    if (!req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      const body = JSON.parse(raw) as {
        messages: Array<{ role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: unknown }>
        tools?: Array<{ type: string; function: { name: string } }>
      }
      capturedRequests.push(body)
      const next = script.shift()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify(
          next ?? { choices: [{ message: { content: '脚本耗尽的兜底回复' } }], usage: { prompt_tokens: 8, completion_tokens: 4 } },
        ),
      )
    })
  })
  await new Promise<void>((resolve) => {
    upstream!.listen(0, '127.0.0.1', () => {
      upstreamPort = (upstream!.address() as { port: number }).port
      resolve()
    })
  })

  const { buildApp } = await import('../src/app')
  app = await buildApp()
  await app.ready()

  const reg = await api<{ tokens: { accessToken: string } }>('POST', '/auth/register', {
    username: 'toolloop_user',
    password: 'pass12345',
    displayName: '工具循环用户',
    device: device('dev-toolloop'),
  })
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
  // 分条投递是 setTimeout 的，等最后一轮落库再关
  await new Promise((resolve) => setTimeout(resolve, 200))
  await app.close()
  const { closeDb } = await import('../src/db')
  closeDb()
  await closeMcp?.()
  await new Promise<void>((resolve) => (upstream ? upstream.close(() => resolve()) : resolve()))
  rmSync(dataDir, { recursive: true, force: true })
})

describe('AI 生成 function calling 循环', () => {
  it('没有工具时请求体不携带 tools 字段，走纯聊天', async () => {
    const before = capturedRequests.length
    const res = await api('POST', '/ai/generations', { conversationId, content: '纯聊天一句话', clientNonce: 'loop-plain' })
    expect(res.status).toBe(200)
    const req = capturedRequests[capturedRequests.length - 1]!
    expect(capturedRequests.length).toBe(before + 1)
    expect(req.tools).toBeUndefined()
    await waitForAiReply('脚本耗尽的兜底回复')
  })

  it('启用的技能注入目录，AI 调 read_skill 拿全文后继续回复', async () => {
    await api('POST', '/skills', {
      name: '天气查询',
      description: '按固定口径播报天气',
      content: '## 天气查询技能\n调用天气 API 后用口语播报，先报城市再报温度。',
      enabled: true,
    })
    await api('POST', '/skills', {
      name: '停用技能',
      description: '不应出现在目录里',
      content: '停用正文',
      enabled: false,
    })

    script.push({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: 'call_read_1', type: 'function', function: { name: 'read_skill', arguments: '{"name":"天气查询"}' } },
            ],
          },
        },
      ],
    })
    script.push({
      choices: [{ message: { content: '今天天气不错，25 度。' } }],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    })

    const before = capturedRequests.length
    const res = await api('POST', '/ai/generations', { conversationId, content: '帮我查下天气', clientNonce: 'loop-skill' })
    expect(res.status).toBe(200)

    const first = capturedRequests[before]!
    // 目录块只含启用技能的名称与描述，不含停用技能，也不含正文
    const catalog = first.messages.find((m) => m.role === 'system' && String(m.content).includes('【可用技能】'))
    expect(catalog).toBeDefined()
    expect(String(catalog!.content)).toContain('天气查询：按固定口径播报天气')
    expect(String(catalog!.content)).not.toContain('停用技能')
    expect(String(catalog!.content)).not.toContain('口语播报，先报城市再报温度')
    // 工具定义包含内置 read_skill
    expect(first.tools?.some((t) => t.function.name === 'read_skill')).toBe(true)

    const second = capturedRequests[before + 1]!
    // 第二轮：assistant 回填 tool_calls，tool 结果带 tool_call_id 与技能全文
    const assistantTurn = second.messages.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))
    expect(assistantTurn).toBeDefined()
    const toolTurn = second.messages.find((m) => m.role === 'tool')
    expect(toolTurn?.tool_call_id).toBe('call_read_1')
    expect(String(toolTurn?.content)).toContain('先报城市再报温度')

    const reply = await waitForAiReply('25 度')
    expect(reply).not.toBeNull()
  })

  it('MCP 工具经真实握手列出并在循环中执行，结果回传上游', async () => {
    // 停用技能，让这轮只有 MCP 工具
    const skills = await api<{ skills: Array<{ id: string; name: string; enabled: boolean }> }>('GET', '/skills')
    for (const skill of skills.json.skills) {
      if (skill.enabled) await api('PATCH', `/skills/${skill.id}`, { enabled: false })
    }

    const created = await api<{ server: { id: string } }>('POST', '/mcp-servers', {
      name: 'Echo MCP',
      url: `http://127.0.0.1:${mcpPort}`,
    })
    expect(created.status).toBe(200)

    script.push({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: 'call_echo_1', type: 'function', function: { name: 'mcp_Echo_MCP_echo', arguments: '{"message":"你好"}' } },
            ],
          },
        },
      ],
    })
    script.push({
      choices: [{ message: { content: '回显结果收到了。' } }],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    })

    const before = capturedRequests.length
    const res = await api('POST', '/ai/generations', { conversationId, content: '试试回显工具', clientNonce: 'loop-echo' })
    expect(res.status).toBe(200)

    const first = capturedRequests[before]!
    // MCP 工具已注册进 tools；技能全部停用时没有 read_skill
    expect(first.tools?.some((t) => t.function.name === 'mcp_Echo_MCP_echo')).toBe(true)
    expect(first.tools?.some((t) => t.function.name === 'read_skill')).toBe(false)

    const second = capturedRequests[before + 1]!
    const toolTurn = second.messages.find((m) => m.role === 'tool')
    expect(toolTurn?.tool_call_id).toBe('call_echo_1')
    expect(String(toolTurn?.content)).toBe('echo:你好')

    const reply = await waitForAiReply('回显结果收到了')
    expect(reply).not.toBeNull()
  })
})
