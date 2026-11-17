import {
  EditMessageSchema,
  SendMessageSchema,
  TypingSchema,
  type ClientEventName,
} from '@nenochat/shared'
import { z } from 'zod'
import type { DB } from '../db'
import type { Conn } from './connection'
import { catchUp, sendEvent, sendResponse, touchPresence, WS_TIMINGS } from './connection'
import * as messageService from '../services/message-service'
import { scheduleGroupResponse } from '../services/group-ai-service'
import { emitTyping, emitReadReceipt } from './emitter'
import { normalizeError } from '../util/errors'
import { now } from '../util/clock'
import { listChanges } from '../services/sync-service'

const IdSchema = z.object({ messageId: z.string().min(1) })
const ReadPayloadSchema = z.object({ conversationId: z.string().min(1), messageSeq: z.number().int().min(0) })
const PresenceSchema = z.object({ status: z.enum(['online', 'away', 'dnd']) })
const SyncPullSchema = z.object({ since: z.number().int().min(0), limit: z.number().int().min(1).max(1000).optional() })
const SubscribeSchema = z.object({ conversationId: z.string().min(1), off: z.boolean().optional() })

/**
 * 客户端请求分发。每个分支都必须显式返回结果，
 * 出错时回一条 res ok:false，绝不让连接因单个请求异常而断开。
 */
export async function handleRequest(
  conn: Conn,
  db: DB,
  id: string,
  event: ClientEventName,
  rawPayload: unknown,
): Promise<void> {
  try {
    if (!conn.userId) {
      sendResponse(conn, id, false, null, { code: 'UNAUTHENTICATED', message: '尚未认证' })
      return
    }
    const userId = conn.userId

    switch (event) {
      case 'ping': {
        sendResponse(conn, id, true, { serverTime: now() })
        return
      }

      case 'message.send': {
        const input = SendMessageSchema.parse(rawPayload)
        const result = messageService.send(db, {
          conversationId: input.conversationId,
          senderId: userId,
          clientNonce: input.clientNonce,
          type: input.type,
          content: input.content,
          meta: input.meta ?? null,
          replyToId: input.replyToId ?? null,
          deviceId: conn.deviceId,
        })
        sendResponse(conn, id, true, result)
        if (!result.duplicated && input.type === 'text') {
          scheduleGroupResponse(db, {
            conversationId: input.conversationId,
            messageId: result.message.id,
            senderId: userId,
            content: result.message.content,
            mentions: result.message.meta?.mentions,
            mentionAll: result.message.meta?.mentionAll,
          })
        }
        return
      }

      case 'message.edit': {
        const parsed = z
          .object({ messageId: z.string().min(1), content: z.string().min(1).max(8000) })
          .parse(rawPayload)
        const message = messageService.edit(db, {
          messageId: parsed.messageId,
          userId,
          content: parsed.content,
          deviceId: conn.deviceId,
        })
        sendResponse(conn, id, true, { message })
        return
      }

      case 'message.delete': {
        const parsed = IdSchema.parse(rawPayload)
        const message = messageService.recall(db, { messageId: parsed.messageId, userId })
        sendResponse(conn, id, true, { message })
        return
      }

      case 'typing': {
        const parsed = TypingSchema.parse(rawPayload)
        emitTyping(db, {
          conversationId: parsed.conversationId,
          userId,
          state: parsed.state,
          expiresAt: now() + 6000,
        })
        sendResponse(conn, id, true, { ok: true })
        return
      }

      case 'read': {
        const parsed = ReadPayloadSchema.parse(rawPayload)
        const result = messageService.markRead(db, {
          conversationId: parsed.conversationId,
          userId,
          seq: parsed.messageSeq,
          deviceId: conn.deviceId,
        })
        if (result.advanced) {
          emitReadReceipt(db, {
            conversationId: parsed.conversationId,
            userId,
            messageSeq: result.lastReadSeq,
            state: 'read',
            at: now(),
          })
        }
        sendResponse(conn, id, true, result)
        return
      }

      case 'presence': {
        const parsed = PresenceSchema.parse(rawPayload)
        touchPresence(db, userId, parsed.status)
        sendResponse(conn, id, true, { ok: true })
        return
      }

      case 'sync.pull': {
        const parsed = SyncPullSchema.parse(rawPayload)
        const batch = listChanges(db, userId, parsed.since, parsed.limit ?? 500)
        sendResponse(conn, id, true, batch)
        return
      }

      case 'subscribe': {
        const parsed = SubscribeSchema.parse(rawPayload)
        if (parsed.off) conn.subscriptions.delete(parsed.conversationId)
        else conn.subscriptions.add(parsed.conversationId)
        sendResponse(conn, id, true, { ok: true })
        return
      }

      case 'ai.cancel': {
        sendResponse(conn, id, true, { ok: true, note: 'P0-5 接入生成链路后生效' })
        return
      }

      default: {
        sendResponse(conn, id, false, null, { code: 'VALIDATION', message: `未知事件: ${String(event)}` })
      }
    }
  } catch (e) {
    sendResponse(conn, id, false, null, normalizeError(e))
  }
}

/** 认证成功后统一走这里：先追平，再补发 pending，最后置为 live */
export function completeHandshake(conn: Conn, db: DB): void {
  catchUp(conn, db)

  const pending = [...conn.pending].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
  conn.pending = []
  conn.state = 'live'

  for (const item of pending) {
    sendEvent(conn, item.event, item.payload, item.seq)
  }
}

export { EditMessageSchema, WS_TIMINGS }
