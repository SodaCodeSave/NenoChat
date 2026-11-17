import { Permission, type Channel, type ChannelKind } from '@nenochat/shared'
import type { DB } from '../db'
import { withTx } from '../db/tx'
import * as channelsRepo from '../db/repo/channels'
import { writeChange } from './change-log'
import { assertMember, assertPermission } from './permission-service'
import { err } from '../util/errors'
import { emitChannelRemoved, emitChannelUpserted } from '../ws/emitter'

export function list(db: DB, conversationId: string, userId: string): Channel[] {
  assertMember(db, conversationId, userId)
  return channelsRepo.listByConversation(db, conversationId).map(channelsRepo.mapChannel)
}

export function create(
  db: DB,
  conversationId: string,
  userId: string,
  input: { name: string; topic?: string | null; kind?: ChannelKind; category?: string | null },
): Channel {
  const channel = withTx(db, () => {
    assertPermission(db, conversationId, userId, Permission.MANAGE_CHANNELS)

    const row = channelsRepo.create(db, {
      conversationId,
      name: input.name,
      topic: input.topic ?? null,
      kind: input.kind ?? 'text',
      category: input.category ?? null,
      createdBy: userId,
    })
    const mapped = channelsRepo.mapChannel(row)
    writeChange(db, {
      entity: 'channel',
      entityId: row.id,
      op: 'upsert',
      conversationId,
      payload: mapped,
      actorId: userId,
    })
    return mapped
  })

  emitChannelUpserted(db, conversationId, channel)
  return channel
}

export function update(
  db: DB,
  channelId: string,
  userId: string,
  patch: channelsRepo.UpdateChannelInput,
): Channel {
  const channel = withTx(db, () => {
    const existing = channelsRepo.findById(db, channelId)
    if (!existing) throw err.notFound('频道不存在')

    assertPermission(db, existing.conversation_id, userId, Permission.MANAGE_CHANNELS)

    const row = channelsRepo.update(db, channelId, patch)
    const mapped = channelsRepo.mapChannel(row)
    writeChange(db, {
      entity: 'channel',
      entityId: channelId,
      op: 'upsert',
      conversationId: existing.conversation_id,
      payload: mapped,
      actorId: userId,
    })
    return mapped
  })

  emitChannelUpserted(db, channel.conversationId, channel)
  return channel
}

export function remove(db: DB, channelId: string, userId: string): void {
  const info = withTx(db, () => {
    const existing = channelsRepo.findById(db, channelId)
    if (!existing) throw err.notFound('频道不存在')

    assertPermission(db, existing.conversation_id, userId, Permission.MANAGE_CHANNELS)

    // 至少保留一个文本频道，否则群会变成无法发言的空壳
    if (
      existing.kind === 'text' &&
      channelsRepo.countActiveTextChannels(db, existing.conversation_id) <= 1
    ) {
      throw err.conflict('至少需要保留一个文本频道')
    }

    channelsRepo.archive(db, channelId)
    writeChange(db, {
      entity: 'channel',
      entityId: channelId,
      op: 'delete',
      conversationId: existing.conversation_id,
      payload: { id: channelId, conversationId: existing.conversation_id },
      actorId: userId,
    })
    return { conversationId: existing.conversation_id }
  })

  emitChannelRemoved(db, info.conversationId, channelId)
}

export function reorder(db: DB, conversationId: string, userId: string, items: channelsRepo.ReorderItem[]): void {
  withTx(db, () => {
    assertPermission(db, conversationId, userId, Permission.MANAGE_CHANNELS)
    channelsRepo.reorder(db, items)
    for (const item of items) {
      const row = channelsRepo.findById(db, item.id)
      if (!row) continue
      writeChange(db, {
        entity: 'channel',
        entityId: item.id,
        op: 'upsert',
        conversationId,
        payload: channelsRepo.mapChannel(row),
        actorId: userId,
      })
    }
  })
}
