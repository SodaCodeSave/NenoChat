import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { Channel } from '@nenochat/shared'
import { channelApi } from '@/api/endpoints'
import { archiveChannel, listChannels, upsertChannel } from '@/db/dao/conversations'
import { hasLocalDb } from '@/platform/db'
import { useServersStore } from './servers'

/** 每个会话的频道列表，按分类 + 位置排序 */
export const useChannelsStore = defineStore('channels', () => {
  const byConversation = ref<Record<string, Channel[]>>({})
  const loading = ref<Record<string, boolean>>({})

  const serverId = computed(() => useServersStore().currentId ?? '')

  function of(conversationId: string): Channel[] {
    return byConversation.value[conversationId] ?? []
  }

  function firstTextChannel(conversationId: string): Channel | null {
    const list = of(conversationId)
    return list.find((c) => c.kind === 'text') ?? list[0] ?? null
  }

  /** 分组后渲染成可折叠的分类区块 */
  const groupedOf = computed(() => (conversationId: string) => {
    const list = of(conversationId)
    const groups = new Map<string, Channel[]>()
    for (const channel of list) {
      const key = channel.category ?? ''
      const bucket = groups.get(key) ?? []
      bucket.push(channel)
      groups.set(key, bucket)
    }
    return [...groups.entries()].map(([category, channels]) => ({ category, channels }))
  })

  async function load(conversationId: string, force = false): Promise<void> {
    if (!force && byConversation.value[conversationId]) return
    loading.value[conversationId] = true
    try {
      if (hasLocalDb() && serverId.value) {
        const local = await listChannels(serverId.value, conversationId)
        if (local.length > 0) byConversation.value[conversationId] = local
      }
      const remote = await channelApi.list(conversationId)
      byConversation.value[conversationId] = remote.channels
      if (hasLocalDb() && serverId.value) {
        for (const channel of remote.channels) {
          await upsertChannel(serverId.value, channel)
        }
      }
    } finally {
      loading.value[conversationId] = false
    }
  }

  async function applyUpserted(channel: Channel): Promise<void> {
    const list = [...(byConversation.value[channel.conversationId] ?? [])]
    const index = list.findIndex((c) => c.id === channel.id)
    if (index >= 0) list[index] = channel
    else list.push(channel)
    byConversation.value[channel.conversationId] = list.sort(
      (a, b) => (a.category ?? '').localeCompare(b.category ?? '') || a.position - b.position,
    )
    if (hasLocalDb() && serverId.value) await upsertChannel(serverId.value, channel)
  }

  async function applyRemoved(conversationId: string, channelId: string): Promise<void> {
    const list = (byConversation.value[conversationId] ?? []).filter((c) => c.id !== channelId)
    byConversation.value[conversationId] = list
    if (hasLocalDb() && serverId.value) await archiveChannel(serverId.value, channelId)
  }

  async function create(
    conversationId: string,
    input: { name: string; topic?: string | null; kind?: 'text' | 'announcement'; category?: string | null },
  ): Promise<Channel> {
    const result = await channelApi.create(conversationId, input)
    await applyUpserted(result.channel)
    return result.channel
  }

  async function update(channelId: string, patch: { name?: string; topic?: string | null; category?: string | null }): Promise<void> {
    const result = await channelApi.update(channelId, patch)
    await applyUpserted(result.channel)
  }

  async function remove(conversationId: string, channelId: string): Promise<void> {
    await channelApi.remove(channelId)
    await applyRemoved(conversationId, channelId)
  }

  function reset(): void {
    byConversation.value = {}
  }

  return {
    byConversation,
    loading,
    of,
    groupedOf,
    firstTextChannel,
    load,
    applyUpserted,
    applyRemoved,
    create,
    update,
    remove,
    reset,
  }
})
