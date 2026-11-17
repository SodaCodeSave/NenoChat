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

/** 没有成员数据的会话共享同一个空索引，避免每次调用都重建 */
const EMPTY_INDEX: Map<string, MemberWithUser> = new Map()

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

  /**
   * conversationId → userId 的成员索引缓存。
   * 以成员列表的引用为失效依据：所有成员增删改都会整体替换数组，
   * 引用一变即重建，与成员 upsert/remove 天然保持同步。
   */
  const indexCache = new Map<string, { source: MemberWithUser[]; index: Map<string, MemberWithUser> }>()

  function memberIndex(conversationId: string): Map<string, MemberWithUser> {
    const list = byConversation.value[conversationId]
    if (!list) return EMPTY_INDEX
    const cached = indexCache.get(conversationId)
    if (cached && cached.source === list) return cached.index
    const index = new Map(list.map((member) => [member.userId, member]))
    indexCache.set(conversationId, { source: list, index })
    return index
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

  /** 仅内存 upsert；镜像写入由调用方决定（sync 批量落库后统一刷新内存，不再逐条写） */
  function upsertLocal(member: Member, user?: PublicUser): void {
    const list = [...of(member.conversationId)]
    const index = list.findIndex((m) => m.userId === member.userId)
    const merged: MemberWithUser = { ...member, user: user ?? profiles.value[member.userId] ?? null }
    if (index >= 0) list[index] = merged
    else list.push(merged)
    byConversation.value[member.conversationId] = list
  }

  async function applyUpserted(conversationId: string, member: Member, user?: PublicUser): Promise<void> {
    upsertLocal(member, user)
    if (user) profiles.value[user.id] = user
    if (hasLocalDb() && serverId.value) {
      await upsertMember(serverId.value, member)
      if (user) await upsertUser(serverId.value, user)
    }
  }

  /** 仅内存移除；镜像写入由调用方决定 */
  function removeLocal(conversationId: string, userId: string): void {
    byConversation.value[conversationId] = of(conversationId).filter((m) => m.userId !== userId)
  }

  async function applyRemoved(conversationId: string, userId: string): Promise<void> {
    removeLocal(conversationId, userId)
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
    indexCache.clear()
  }

  return {
    byConversation,
    profiles,
    online,
    loading,
    of,
    memberIndex,
    groupedOf,
    load,
    upsertLocal,
    removeLocal,
    applyUpserted,
    applyRemoved,
    setOnline,
    displayName,
    reset,
  }
})
