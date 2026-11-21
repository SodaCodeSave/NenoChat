import { testDatabaseUrl } from './helpers/pg'
import { createServer, type Server } from 'node:http'
import fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ulid } from '@nenochat/shared'
import { all, dataDir, getDb, run, type DB } from '../src/db'
import * as connectorService from '../src/services/connector-service'
import * as voiceService from '../src/services/voice-service'
import { appendAiSegment } from '../src/services/ai-service'

const dataDirectory = mkdtempSync(path.join(tmpdir(), 'nenochat-voice-'))
process.env.NODE_ENV = 'test'
process.env.DATA_DIR = dataDirectory
process.env.DATABASE_URL = testDatabaseUrl(import.meta.url)
process.env.LOG_LEVEL = 'fatal'
process.env.JWT_SECRET = 'test-jwt-secret-at-least-16-chars'
process.env.SECRET_KEY = 'test-aes-secret-at-least-16-chars'

let app: FastifyInstance
let upstream: Server
let upstreamPort = 0
let db: DB
let token = ''
let userId = ''
let connectorId = ''

/** 上游记录到的最近一次请求，供断言密钥、模型与消息结构 */
let lastSeen = { url: '', authorization: '', body: '' }

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

/** 生成一段结构合法的 WAV（静音数据），让 wavDurationSeconds 有真实头部可解析 */
function makeWav(seconds: number, sampleRate = 24_000): Buffer {
  const dataSize = Math.floor(seconds * sampleRate) * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataSize, 40)
  return buf
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    lastSeen = {
      url: req.url ?? '',
      authorization: String(req.headers.authorization ?? ''),
      body: '',
    }
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        lastSeen.body = body
        const parsed = JSON.parse(body) as { audio?: unknown }
        // 带 audio 参数的是 TTS 调用；其余按普通 chat 处理
        const payload = 'audio' in parsed
          ? { choices: [{ message: { audio: { data: makeWav(1).toString('base64') } } }] }
          : { choices: [{ message: { content: '连接成功' } }] }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  upstreamPort = typeof address === 'object' && address ? address.port : 0

  const { buildApp } = await import('../src/app')
  app = await buildApp()
  await app.ready()
  db = getDb()

  const reg = await api<{ user: { id: string }; tokens: { accessToken: string } }>(
    'POST',
    '/auth/register',
    {
      body: {
        username: 'voice_user',
        password: 'pass12345',
        displayName: '语音测试',
        device: device('dev-voice'),
      },
    },
  )
  userId = reg.json.user.id
  token = reg.json.tokens.accessToken

  const created = await api<{ connector: { id: string } }>('POST', '/connectors', {
    token,
    body: {
      type: 'mimo_tts',
      name: 'MiMo 语音',
      config: {
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        ttsVoice: '冰糖',
        ttsInstruction: '温柔一点',
        voiceProbability: 0.5,
        voiceTool: true,
      },
      secret: { apiKey: 'mimo-secret-key' },
    },
  })
  expect(created.status).toBe(200)
  connectorId = created.json.connector.id
})

afterAll(async () => {
  await app.close()
  const { closeDb } = await import('../src/db')
  await closeDb()
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
  try {
    rmSync(dataDirectory, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
})

describe('MiMo 语音连接器配置', () => {
  /** 配置测试用独立用户，避免多个连接器影响 enabledConnectorOfType 的取行 */
  let configUserId = ''

  beforeAll(async () => {
    const reg = await api<{ user: { id: string } }>('POST', '/auth/register', {
      body: {
        username: 'voice_config_user',
        password: 'pass12345',
        displayName: '配置测试',
        device: device('dev-voice-config'),
      },
    })
    configUserId = reg.json.user.id
  })

  it('未填配置时补齐默认值：默认音色、概率 0、工具关闭', async () => {
    const connector = await connectorService.createConnector(db, configUserId, {
      type: 'mimo_tts',
      name: 'MiMo 默认',
      secret: { apiKey: 'mimo-default-key' },
    })
    expect(connector.config.ttsVoice).toBe('mimo_default')
    expect(connector.config.voiceProbability).toBe(0)
    expect(connector.config.voiceTool).toBe(false)
    expect(connector.config.ttsInstruction).toBeNull()
    expect(connector.secretMasked.apiKey).not.toBeNull()
  })

  it('概率越界被收敛到 0-1', async () => {
    const connector = await connectorService.createConnector(db, configUserId, {
      type: 'mimo_tts',
      name: 'MiMo 概率',
      config: { voiceProbability: 7 },
      secret: { apiKey: 'mimo-clamp-key' },
    })
    expect(connector.config.voiceProbability).toBe(1)
  })

  it('没填 API Key 时创建直接被拒绝', async () => {
    await expect(
      connectorService.createConnector(db, configUserId, { type: 'mimo_tts', name: '无密钥' }),
    ).rejects.toThrow('MiMo 语音连接器需要填写 API Key')
  })
})

describe('MiMo TTS 合成', () => {
  it('调用 chat.completions 并解析出 WAV 音频', async () => {
    const row = await connectorService.enabledConnectorOfType(db, userId, 'mimo_tts')
    expect(row).not.toBeNull()
    const result = await connectorService.synthesizeMimoTts(row!, '你好呀，很高兴认识你。')
    expect(result.mime).toBe('audio/wav')
    expect(result.bytes.subarray(0, 4).toString('ascii')).toBe('RIFF')

    expect(lastSeen.authorization).toBe('Bearer mimo-secret-key')
    expect(lastSeen.url).toBe('/v1/chat/completions')
    const body = JSON.parse(lastSeen.body) as {
      model?: string
      audio?: { format?: string; voice?: string }
      messages?: Array<{ role: string; content: string }>
    }
    expect(body.model).toBe('mimo-v2.5-tts')
    expect(body.audio).toEqual({ format: 'wav', voice: '冰糖' })
    // 目标文本必须放在 assistant 消息里，风格指令放在 user 消息里
    expect(body.messages).toEqual([
      { role: 'user', content: '温柔一点' },
      { role: 'assistant', content: '你好呀，很高兴认识你。' },
    ])
  })

  it('测试连接端点返回成功与时长说明', async () => {
    const res = await api<{ ok: boolean; message: string }>(
      'POST',
      `/connectors/${connectorId}/test`,
      { token },
    )
    expect(res.status).toBe(200)
    expect(res.json.ok).toBe(true)
    expect(res.json.message).toContain('连接成功')
  })

  it('wavDurationSeconds 解析头部，坏数据按 24kHz 估算', () => {
    expect(connectorService.wavDurationSeconds(makeWav(2))).toBeCloseTo(2, 1)
    expect(connectorService.wavDurationSeconds(Buffer.from([1, 2, 3]))).toBeGreaterThan(0)
  })
})

describe('MiMo ASR（预留函数）', () => {
  it('当前一律抛出「暂未开放」', async () => {
    const row = await connectorService.enabledConnectorOfType(db, userId, 'mimo_tts')
    await expect(
      connectorService.transcribeMimoAsr(row!, { base64: 'aGk=', mime: 'audio/webm' }),
    ).rejects.toThrow('语音识别暂未开放')
  })
})

describe('planVoiceSegment', () => {
  it('带 [[voice]] 标记且有连接器时命中', async () => {
    const plan = await voiceService.planVoiceSegment(db, userId, '[[voice]]今晚想早点睡')
    expect(plan.voice).toBe(true)
    expect(plan.marked).toBe(true)
    expect(plan.text).toBe('今晚想早点睡')
  })

  it('概率未命中时按文字处理', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.99)
    const plan = await voiceService.planVoiceSegment(db, userId, '普通一句话')
    expect(plan.voice).toBe(false)
    expect(plan.marked).toBe(false)
    expect(plan.text).toBe('普通一句话')
    random.mockRestore()
  })

  it('概率命中时转语音', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.01)
    const plan = await voiceService.planVoiceSegment(db, userId, '普通一句话')
    expect(plan.voice).toBe(true)
    expect(plan.text).toBe('普通一句话')
    random.mockRestore()
  })

  it('没有连接器的用户永远按文字处理', async () => {
    const plan = await voiceService.planVoiceSegment(db, 'no-such-owner', '[[voice]]你好')
    expect(plan.voice).toBe(false)
    expect(plan.text).toBe('你好')
  })
})

describe('appendAiSegment 语音分条落库', () => {
  async function insertAiConversation(ownerId: string): Promise<string> {
    const id = ulid()
    const ts = Date.now()
    await run(
      db,
      `INSERT INTO conversations (id, type, name, ai_owner_user_id, seq_counter, message_count, created_at, updated_at)
       VALUES (?, 'ai', '语音测试角色', ?, 0, 0, ?, ?)`,
      [id, ownerId, ts, ts],
    )
    return id
  }

  it('带 [[voice]] 标记的分条转成语音消息并保存音频附件', async () => {
    const conversationId = await insertAiConversation(userId)
    const message = await appendAiSegment(db, conversationId, {
      generationId: ulid(),
      index: 0,
      content: '[[voice]]晚安，做个好梦。',
      clientNonce: `voice-seg-${ulid()}`,
    })
    expect(message.type).toBe('voice')
    expect(message.content).toBe('晚安，做个好梦。')
    const attachment = message.meta?.attachments?.[0]
    expect(attachment?.kind).toBe('voice')
    expect(attachment?.mime).toBe('audio/wav')
    expect(attachment?.duration).toBeGreaterThan(0)
    expect(attachment?.url).toMatch(/^\/files\//)

    // 音频真实落盘，客户端能按相对地址拉到
    const absolute = path.join(dataDir(), 'files', attachment!.url.replace(/^\/files\//, ''))
    expect(fs.existsSync(absolute)).toBe(true)
    expect(fs.statSync(absolute).size).toBeGreaterThan(44)
  })

  it('没有标记且概率未命中的分条保持文字', async () => {
    // 主连接器配了 0.5 概率，掷骰固定为不命中，验证文字路径不受影响
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.99)
    const conversationId = await insertAiConversation(userId)
    const message = await appendAiSegment(db, conversationId, {
      generationId: ulid(),
      index: 0,
      content: '普通文字回复',
      clientNonce: `text-seg-${ulid()}`,
    })
    expect(message.type).toBe('text')
    expect(message.content).toBe('普通文字回复')
    random.mockRestore()
  })

  it('连接器不可用时标记被剥掉，降级为文字', async () => {
    const orphanId = ulid()
    const ts = Date.now()
    await run(
      db,
      `INSERT INTO users (id, username, display_name, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [orphanId, `voice_orphan_${ts}`, '无连接器用户', 'x', ts, ts],
    )
    const conversationId = await insertAiConversation(orphanId)
    const message = await appendAiSegment(db, conversationId, {
      generationId: ulid(),
      index: 0,
      content: '[[voice]]你好',
      clientNonce: `orphan-seg-${ulid()}`,
    })
    expect(message.type).toBe('text')
    expect(message.content).toBe('你好')
  })
})
