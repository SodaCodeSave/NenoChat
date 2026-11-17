import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { Member, PublicUser } from '@nenochat/shared'
import { conversationApi } from '@/api/endpoints'
import { listMembers, markMemberLeft, upsertMember } from '@/db/dao/conversations'
import { upsertUser, upsertUsers } from '@/db/dao/users'
import { hasLocalDb } from '@/platform/db'
import { useServersStore } from './servers'

export interface MemberWithUser extends Member {
  user: PublicUser | null
  online?: boolean
}

/** 会话成员与成员资料缓存 */
export const useMembersStore = defineStore('members', () => {
  const byConversation = ref<Record<string, MemberWithUser[]>>({})
  const profiles = ref<Record<string, PublicUser>>({})
  const online = ref<Record<string, boolean>>({})
  const loading = ref<Record<string, boolean>>({})

  const serverId = computed(() => useServersStore().currentId ?? '')

  function of(conversationId: string): MemberWithUser[] {
    return byConversation.value[conversationId] ?? []
  }

  const groupedOf = computed(() => (conversationId: string) => {
    const list = of(conversationId)
    const owner = list.filter((m) => m.role === 'owner')
    const admins = list.filter((m) => m.role === 'admin')
    const onlineMembers = list.filter((m) => m.role === 'member' && online.value[m.userId])
    const offline = list.filter((m) => m.role === 'member' && !online.value[m.userId])
    return [
      { key: 'owner', label: '群主', members: owner },
      { key: 'admin', label: '管理员', members: admins },
      { key: 'online', label: '在线', members: onlineMembers },
      { key: 'offline', label: '离线', members: offline },
    ].filter((group) => group.members.length > 0)
  })

  async function load(conversationId: string, force = false): Promise<void> {
    if (!force && byConversation.value[conversationId]) return
    loading.value[conversationId] = true
    try {
      if (hasLocalDb() && serverId.value) {
        const local = await listMembers(serverId.value, conversationId)
        if (local.length > 0) {
          byConversation.value[conversationId] = local.map((m) => ({
            ...m,
            user: profiles.value[m.userId] ?? null,
          }))
        }
      }

      const detail = await conversationApi.detail(conversationId)
      const withUsers: MemberWithUser[] = detail.members.map((m) => ({
        ...m,
        user: m.user ?? null,
      }))
      byConversation.value[conversationId] = withUsers

      for (const member of detail.members) {
        if (member.user) profiles.value[member.user.id] = member.user
      }
      if (hasLocalDb() && serverId.value) {
        for (const member of detail.members) {
          await upsertMember(serverId.value, member)
        }
        await upsertUsers(
          serverId.value,
          detail.members.map((m) => m.user).filter((u): u is PublicUser => Boolean(u)),
        )
      }
    } finally {
      loading.value[conversationId] = false
    }
  }

  async function applyUpserted(conversationId: string, member: Member, user?: PublicUser): Promise<void> {
    const list = [...of(conversationId)]
    const index = list.findIndex((m) => m.userId === member.userId)
    const merged: MemberWithUser = { ...member, user: user ?? profiles.value[member.userId] ?? null }
    if (index >= 0) list[index] = merged
    else list.push(merged)
    byConversation.value[conversationId] = list

    if (user) profiles.value[user.id] = user
    if (hasLocalDb() && serverId.value) {
      await upsertMember(serverId.value, member)
      if (user) await upsertUser(serverId.value, user)
    }
  }

  async function applyRemoved(conversationId: string, userId: string): Promise<void> {
    byConversation.value[conversationId] = of(conversationId).filter((m) => m.userId !== userId)
    if (hasLocalDb() && serverId.value) await markMemberLeft(serverId.value, conversationId, userId)
  }

  function setOnline(userId: string, isOnline: boolean): void {
    online.value[userId] = isOnline
  }

  function displayName(member: MemberWithUser): string {
    return member.nickname || member.user?.displayName || member.userId
  }

  function reset(): void {
    byConversation.value = {}
    profiles.value = {}
    online.value = {}
  }

  return {
    byConversation,
    profiles,
    online,
    loading,
    of,
    groupedOf,
    load,
    applyUpserted,
    applyRemoved,
    setOnline,
    displayName,
    reset,
  }
})
