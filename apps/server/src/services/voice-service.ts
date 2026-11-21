import {
  SenderType,
  extractVoiceMarker,
  stripStickerMarkers,
  ulid,
  type ConnectorActionMeta,
  type Message,
  type MessageMeta,
} from '@nenochat/shared'
import type { DB } from '../db'
import * as connectorService from './connector-service'
import { saveUpload } from './file-service'
import { appendSystemMessage } from './message-service'

/**
 * AI 语音消息管线。
 *
 * 两条触发路径都落在分条落库这一步：
 * 1. 工具模式：模型在分条里写 [[voice]] 标记（连接器 voiceTool 开启时提示词里有协议说明）；
 * 2. 概率模式：连接器配置 voiceProbability，掷骰命中就把该分条转成语音。
 * 任一环节失败都降级为普通文字，绝不丢回复。
 */

export interface VoicePlan {
  /** 该分条是否要转成语音 */
  voice: boolean
  /** 分条里是否写了 [[voice]] 标记（哪怕没有连接器，标记也要从正文里剥掉） */
  marked: boolean
  /** 去掉标记后的正文（无论是否转语音都返回，供降级为文字时使用） */
  text: string
}

/**
 * 决定一条 AI 分条是否转语音：先看 [[voice]] 标记，
 * 再按连接器配置的概率掷骰；没有可用的 MiMo 连接器时一律按文字处理。
 */
export async function planVoiceSegment(
  db: DB,
  ownerId: string | null,
  rawContent: string,
): Promise<VoicePlan> {
  const { voice: marked, text } = extractVoiceMarker(rawContent)
  const clean = stripStickerMarkers(text).trim()
  if (!clean) return { voice: false, marked: false, text: '' }
  if (!ownerId) return { voice: false, marked, text: clean }

  const row = await connectorService.enabledConnectorOfType(db, ownerId, 'mimo_tts')
  if (!row) return { voice: false, marked, text: clean }

  if (marked) return { voice: true, marked: true, text: clean }

  let probability = 0
  try {
    const config = JSON.parse(row.config || '{}') as { voiceProbability?: unknown }
    probability = typeof config.voiceProbability === 'number' ? config.voiceProbability : 0
  } catch {
    probability = 0
  }
  if (probability > 0 && Math.random() < probability) {
    return { voice: true, marked, text: clean }
  }
  return { voice: false, marked, text: clean }
}

export interface AppendVoiceMessageInput {
  conversationId: string
  ownerId: string
  text: string
  generationId: string
  index: number
  personaId?: string
  model?: string
  totalSegments?: number
  proactive?: boolean
  /** 本次回复用过的连接器动作，随 meta 落库（与文字分条同一形态） */
  connector?: ConnectorActionMeta[]
  clientNonce?: string | null
}

/**
 * 合成语音并落库为一条语音消息。
 * 合成或保存失败返回 null，由调用方降级为文字消息。
 */
export async function appendVoiceMessage(
  db: DB,
  input: AppendVoiceMessageInput,
): Promise<Message | null> {
  try {
    const row = await connectorService.enabledConnectorOfType(db, input.ownerId, 'mimo_tts')
    if (!row) return null
    connectorService.takeRateLimit(`tts:${input.ownerId}`, 20, 60_000)

    const audio = await connectorService.synthesizeMimoTts(row, input.text)
    const attachment = await saveUpload(db, {
      userId: input.ownerId,
      buffer: audio.bytes,
      filename: `mimo-voice-${ulid()}.wav`,
      mime: audio.mime,
      kind: 'file',
    })
    const duration = connectorService.wavDurationSeconds(audio.bytes)

    const meta: MessageMeta = {
      ai: {
        generationId: input.generationId,
        index: input.index,
        model: input.model,
        personaId: input.personaId,
        totalSegments: input.totalSegments,
        ...(input.proactive ? { proactive: true } : {}),
        ...(input.connector?.length ? { connector: input.connector } : {}),
      },
      attachments: [
        {
          id: attachment.id,
          kind: 'voice',
          filename: attachment.filename,
          mime: audio.mime,
          size: audio.bytes.length,
          duration: Math.round(duration * 10) / 10,
          url: attachment.url,
        },
      ],
    }

    return await appendSystemMessage(db, {
      conversationId: input.conversationId,
      senderType: SenderType.Ai,
      type: 'voice',
      content: input.text,
      meta,
      aiGenerationId: input.generationId,
      aiIndex: input.index,
      clientNonce: input.clientNonce ?? null,
    })
  } catch {
    // 合成失败只降级为文字，不打断整轮回复
    return null
  }
}
