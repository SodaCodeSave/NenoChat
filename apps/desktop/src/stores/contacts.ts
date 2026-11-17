import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { ContactRelation, type Contact } from '@nenochat/shared'
import { contactApi } from '@/api/endpoints'

/**
 * 通讯录：真人与 AI 角色共用一份好友列表。
 * AI 在服务端也是 users 表里的一行，所以这里不需要任何分支逻辑。
 */
export const useContactsStore = defineStore('contacts', () => {
  const friends = ref<Contact[]>([])
  const incoming = ref<Contact[]>([])
  const outgoing = ref<Contact[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref<string | null>(null)

  const incomingCount = computed(() => incoming.value.length)

  function displayName(contact: Contact): string {
    return contact.alias || contact.user?.displayName || contact.user?.username || contact.contactUserId
  }

  function sortFriends(): void {
    friends.value = [...friends.value].sort((a, b) =>
      displayName(a).localeCompare(displayName(b), 'zh-CN'),
    )
  }

  function dropEverywhere(contactUserId: string): void {
    friends.value = friends.value.filter((item) => item.contactUserId !== contactUserId)
    incoming.value = incoming.value.filter((item) => item.contactUserId !== contactUserId)
    outgoing.value = outgoing.value.filter((item) => item.contactUserId !== contactUserId)
  }

  /** 单条联系人变更（REST 返回值与 WS 事件共用） */
  function upsert(contact: Contact): void {
    if (!contact.relation) {
      dropEverywhere(contact.contactUserId)
      return
    }
    dropEverywhere(contact.contactUserId)
    if (contact.relation === ContactRelation.Friend) {
      friends.value = [...friends.value, contact]
      sortFriends()
    } else if (contact.relation === ContactRelation.PendingIn) {
      incoming.value = [...incoming.value, contact]
    } else if (contact.relation === ContactRelation.PendingOut) {
      outgoing.value = [...outgoing.value, contact]
    }
  }

  function remove(contactUserId: string): void {
    dropEverywhere(contactUserId)
  }

  async function load(force = false): Promise<void> {
    if (loading.value) return
    if (loaded.value && !force) return
    loading.value = true
    error.value = null
    try {
      const result = await contactApi.list()
      friends.value = result.friends
      incoming.value = result.incoming
      outgoing.value = result.outgoing
      sortFriends()
      loaded.value = true
    } catch (e) {
      error.value = e instanceof Error ? e.message : '加载通讯录失败'
    } finally {
      loading.value = false
    }
  }

  async function sendRequest(userId: string, message?: string): Promise<Contact> {
    const result = await contactApi.request(userId, message)
    upsert(result.contact)
    return result.contact
  }

  async function accept(userId: string): Promise<void> {
    const result = await contactApi.accept(userId)
    dropEverywhere(userId)
    upsert(result.contact)
  }

  async function decline(userId: string): Promise<void> {
    await contactApi.decline(userId)
    remove(userId)
  }

  async function addPersona(personaId: string): Promise<Contact> {
    const result = await contactApi.addPersona(personaId)
    upsert(result.contact)
    return result.contact
  }

  async function setAlias(userId: string, alias: string | null): Promise<void> {
    const result = await contactApi.setAlias(userId, alias)
    upsert(result.contact)
  }

  async function removeFriend(userId: string): Promise<void> {
    await contactApi.remove(userId)
    remove(userId)
  }

  function reset(): void {
    friends.value = []
    incoming.value = []
    outgoing.value = []
    loaded.value = false
    error.value = null
  }

  return {
    friends,
    incoming,
    outgoing,
    loading,
    loaded,
    error,
    incomingCount,
    displayName,
    upsert,
    remove,
    load,
    sendRequest,
    accept,
    decline,
    addPersona,
    setAlias,
    removeFriend,
    reset,
  }
})
