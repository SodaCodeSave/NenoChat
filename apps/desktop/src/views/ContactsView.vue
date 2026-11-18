<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { AiPersona, Contact, PublicUser } from '@nenochat/shared'
import Avatar from '@/components/ui/Avatar.vue'
import Icon from '@/components/ui/Icon.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import { conversationApi, userApi } from '@/api/endpoints'
import { aiApi } from '@/api/ai'
import { useAiStore } from '@/stores/ai'
import { useContactsStore } from '@/stores/contacts'
import { useConversationsStore } from '@/stores/conversations'
import { useUiStore } from '@/stores/ui'

const router = useRouter()
const contacts = useContactsStore()
const conversations = useConversationsStore()
const ai = useAiStore()
const ui = useUiStore()

const keyword = ref('')
const results = ref<PublicUser[]>([])
const searching = ref(false)
const error = ref<string | null>(null)
const starting = ref<string | null>(null)
const showPersonaPicker = ref(false)
const editingId = ref<string | null>(null)
const aliasDraft = ref('')

const friends = computed(() => contacts.friends)
const friendIds = computed(() => new Set(contacts.friends.map((item) => item.contactUserId)))
const outgoingIds = computed(() => new Set(contacts.outgoing.map((item) => item.contactUserId)))
const incomingIds = computed(() => new Set(contacts.incoming.map((item) => item.contactUserId)))

/** 自己的 AI 角色里还没进通讯录的；进群、私聊都不受影响 */
const personaCandidates = computed(() =>
  ai.personas.filter((persona) => persona.userId && !friendIds.value.has(persona.userId)),
)

const personaByUserId = computed(() => {
  const map = new Map<string, AiPersona>()
  for (const persona of ai.personas) {
    if (persona.userId) map.set(persona.userId, persona)
  }
  return map
})

onMounted(() => {
  void contacts.load()
  void ai.load()
})

function subtitleOf(contact: Contact): string {
  const user = contact.user
  if (!user) return ''
  // AI 影子账号的 username 是内部 id，不展示
  if (user.username.startsWith('ai_')) return user.bio ?? ''
  return `@${user.username}${user.bio ? ` · ${user.bio}` : ''}`
}

/** 搜索结果每行都要判一次关系：Set 一次查表，代替三次数组扫描 */
function relationWith(userId: string): 'friend' | 'outgoing' | 'incoming' | null {
  if (friendIds.value.has(userId)) return 'friend'
  if (outgoingIds.value.has(userId)) return 'outgoing'
  if (incomingIds.value.has(userId)) return 'incoming'
  return null
}

async function openPersonaChat(persona: AiPersona): Promise<void> {
  error.value = null
  starting.value = persona.id
  try {
    const result = await aiApi.openConversation({
      personaId: persona.id,
      providerId: persona.providerId ?? undefined,
    })
    await conversations.refresh()
    await router.push(`/c/${result.conversation.id}`)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '无法打开会话'
  } finally {
    starting.value = null
  }
}

async function startDirect(userId: string, key: string): Promise<void> {
  starting.value = key
  try {
    const result = await conversationApi.create({ type: 'direct', targetUserId: userId })
    await conversations.refresh()
    await router.push(`/c/${result.conversation.id}`)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '无法发起会话'
  } finally {
    starting.value = null
  }
}

async function openContact(contact: Contact): Promise<void> {
  const persona = personaByUserId.value.get(contact.contactUserId)
  if (persona) {
    await openPersonaChat(persona)
    return
  }
  await startDirect(contact.contactUserId, contact.contactUserId)
}

async function sendRequest(user: PublicUser): Promise<void> {
  error.value = null
  starting.value = user.id
  try {
    await contacts.sendRequest(user.id)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '发送申请失败'
  } finally {
    starting.value = null
  }
}

async function respond(contact: Contact, accept: boolean): Promise<void> {
  error.value = null
  try {
    if (accept) await contacts.accept(contact.contactUserId)
    else await contacts.decline(contact.contactUserId)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '操作失败'
  }
}

async function addPersona(persona: AiPersona): Promise<void> {
  error.value = null
  try {
    await contacts.addPersona(persona.id)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加入通讯录失败'
  }
}

function beginRename(contact: Contact): void {
  editingId.value = contact.contactUserId
  aliasDraft.value = contact.alias ?? ''
}

async function commitRename(contact: Contact): Promise<void> {
  if (editingId.value !== contact.contactUserId) return
  editingId.value = null
  try {
    await contacts.setAlias(contact.contactUserId, aliasDraft.value.trim() || null)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '修改备注失败'
  }
}

async function removeContact(contact: Contact): Promise<void> {
  error.value = null
  try {
    await contacts.removeFriend(contact.contactUserId)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '移除失败'
  }
}

let timer: ReturnType<typeof setTimeout> | null = null

watch(keyword, (value) => {
  if (timer) clearTimeout(timer)
  const query = value.trim()
  if (!query) {
    results.value = []
    return
  }
  timer = setTimeout(async () => {
    searching.value = true
    error.value = null
    try {
      const found = await userApi.search(query)
      results.value = found.users
    } catch (e) {
      error.value = e instanceof Error ? e.message : '搜索失败'
    } finally {
      searching.value = false
    }
  }, 260)
})

// 搜索防抖定时器随组件清掉，避免切走页面后还回来改结果
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})
</script>

<template>
  <div class="flex h-full flex-col">
    <header
      class="flex shrink-0 items-center justify-between gap-2 border-b border-line px-4 pb-1"
      :class="
        ui.isMobile
          ? 'min-h-[calc(3rem+var(--safe-top))] pt-[var(--safe-top)]'
          : 'h-14'
      "
      data-tauri-drag-region
    >
      <h1 class="text-[16px] font-semibold text-text-strong">
        通讯录
        <span v-if="friends.length > 0" class="ml-1 text-[12px] font-normal text-muted">
          {{ friends.length }}
        </span>
      </h1>
      <button
        type="button"
        class="flex items-center gap-1 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12px] text-text hover:bg-surface-2 active:bg-surface-3"
        title="把 AI 角色加入通讯录"
        @click="showPersonaPicker = !showPersonaPicker"
      >
        <Icon name="plus" :size="13" />
        AI 角色
      </button>
    </header>

    <div class="scroll-area flex-1 px-4 py-4 md:px-5 md:py-5">
      <div class="mx-auto max-w-2xl">
        <div class="relative">
          <span class="absolute top-1/2 left-3 -translate-y-1/2 text-muted">
            <Icon name="search" :size="16" />
          </span>
          <input
            v-model="keyword"
            type="search"
            placeholder="搜索用户名或昵称，添加好友"
            class="h-10 w-full rounded-xl border border-line bg-surface-2 pl-9 pr-3 text-[13.5px] outline-none focus:border-accent"
          />
        </div>

        <p v-if="error" class="mt-2 text-[12px] text-danger">{{ error }}</p>

        <!-- 首次加载：联系人列表骨架屏 -->
        <div
          v-if="contacts.loading && friends.length === 0 && !keyword"
          class="mt-5 space-y-1"
          aria-hidden="true"
        >
          <Skeleton width="72px" height="11px" class="mb-2" />
          <div
            v-for="index in 5"
            :key="index"
            class="flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2"
          >
            <Skeleton circle width="38px" height="38px" />
            <div class="min-w-0 flex-1 space-y-1.5">
              <Skeleton :width="`${34 + (index % 3) * 10}%`" height="12px" />
              <Skeleton :width="`${48 + (index % 4) * 8}%`" height="10px" />
            </div>
          </div>
        </div>

        <section v-if="showPersonaPicker" class="mt-3 rounded-xl border border-line bg-surface-2 p-3">
          <div class="mb-2 flex items-center justify-between">
            <p class="text-[11px] font-medium tracking-wide text-muted">我的 AI 角色</p>
            <button type="button" class="text-muted hover:text-text" @click="showPersonaPicker = false">
              <Icon name="close" :size="13" />
            </button>
          </div>
          <p v-if="personaCandidates.length === 0" class="py-2 text-[12px] text-muted">
            所有角色都已在通讯录里
          </p>
          <div
            v-for="persona in personaCandidates"
            :key="persona.id"
            class="mb-1 flex items-center gap-3 rounded-lg bg-surface px-2.5 py-2"
          >
            <Avatar :name="persona.name" :src="persona.avatarUrl" :seed="persona.id" :size="32" />
            <div class="min-w-0 flex-1">
              <p class="truncate text-[13px] text-text-strong">{{ persona.name }}</p>
              <p class="truncate text-[11px] text-muted">
                {{ persona.interests.slice(0, 3).join(' · ') || 'AI 角色' }}
              </p>
            </div>
            <button
              type="button"
              class="rounded-lg border border-line px-2 py-1 text-[12px] text-text hover:bg-surface-2"
              @click="addPersona(persona)"
            >
              加入通讯录
            </button>
          </div>
        </section>

        <!-- 新的朋友 -->
        <section v-if="contacts.incoming.length > 0" class="mt-5">
          <p class="mb-1 text-[11px] font-medium tracking-wide text-muted">
            新的朋友 · {{ contacts.incoming.length }}
          </p>
          <div
            v-for="contact in contacts.incoming"
            :key="contact.contactUserId"
            class="mb-1 flex items-center gap-3 rounded-xl border border-accent/30 bg-accent/5 px-3 py-2"
          >
            <Avatar
              :name="contact.user?.displayName ?? contact.contactUserId"
              :src="contact.user?.avatarUrl"
              :seed="contact.contactUserId"
              :size="36"
            />
            <div class="min-w-0 flex-1">
              <p class="truncate text-[13px] font-medium text-text-strong">
                {{ contact.user?.displayName ?? contact.contactUserId }}
              </p>
              <p class="truncate text-[11px] text-muted">
                {{ contact.requestMessage || '想加你为好友' }}
              </p>
            </div>
            <button
              type="button"
              class="rounded-lg bg-accent px-2.5 py-1 text-[12px] font-medium text-accent-text"
              @click="respond(contact, true)"
            >
              同意
            </button>
            <button
              type="button"
              class="rounded-lg border border-line px-2.5 py-1 text-[12px] text-muted hover:text-text"
              @click="respond(contact, false)"
            >
              拒绝
            </button>
          </div>
        </section>

        <!-- 搜索 -->
        <section v-if="keyword" class="mt-4">
          <p class="mb-1 text-[11px] font-medium tracking-wide text-muted">搜索结果</p>
          <p v-if="searching" class="py-3 text-center text-[12px] text-muted">搜索中…</p>
          <p v-else-if="results.length === 0" class="py-3 text-center text-[12px] text-muted">
            没有找到匹配的用户
          </p>
          <div
            v-for="user in results"
            :key="user.id"
            class="mb-1 flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2"
          >
            <Avatar :name="user.displayName" :src="user.avatarUrl" :seed="user.id" :size="36" />
            <div class="min-w-0 flex-1">
              <p class="truncate text-[13px] font-medium text-text-strong">{{ user.displayName }}</p>
              <p class="truncate text-[11px] text-muted">
                @{{ user.username }}{{ user.bio ? ` · ${user.bio}` : '' }}
              </p>
            </div>
            <button
              v-if="relationWith(user.id) === 'friend'"
              type="button"
              class="rounded-lg border border-line px-2.5 py-1 text-[12px] text-text hover:bg-surface-2"
              :disabled="starting === user.id"
              @click="startDirect(user.id, user.id)"
            >
              发消息
            </button>
            <button
              v-else-if="relationWith(user.id) === 'outgoing'"
              type="button"
              class="rounded-lg border border-line px-2.5 py-1 text-[12px] text-muted"
              disabled
            >
              等待验证
            </button>
            <button
              v-else-if="relationWith(user.id) === 'incoming'"
              type="button"
              class="rounded-lg bg-accent px-2.5 py-1 text-[12px] font-medium text-accent-text"
              @click="respond({ contactUserId: user.id } as Contact, true)"
            >
              同意
            </button>
            <button
              v-else
              type="button"
              class="flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1 text-[12px] font-medium text-accent-text disabled:opacity-60"
              :disabled="starting === user.id"
              @click="sendRequest(user)"
            >
              <Icon name="plus" :size="13" />
              加好友
            </button>
          </div>
        </section>

        <!-- 我发出的申请 -->
        <section v-if="!keyword && contacts.outgoing.length > 0" class="mt-5">
          <p class="mb-1 text-[11px] font-medium tracking-wide text-muted">已发出申请</p>
          <div
            v-for="contact in contacts.outgoing"
            :key="contact.contactUserId"
            class="mb-1 flex items-center gap-3 rounded-xl border border-dashed border-line px-3 py-2"
          >
            <Avatar
              :name="contact.user?.displayName ?? contact.contactUserId"
              :src="contact.user?.avatarUrl"
              :seed="contact.contactUserId"
              :size="32"
            />
            <p class="min-w-0 flex-1 truncate text-[13px] text-text">
              {{ contact.user?.displayName ?? contact.contactUserId }}
            </p>
            <span class="text-[11px] text-muted">等待对方同意</span>
          </div>
        </section>

        <!-- 好友：真人与 AI 同一个列表 -->
        <section v-if="!keyword" class="mt-5">
          <p class="mb-1 text-[11px] font-medium tracking-wide text-muted">联系人</p>

          <div
            v-for="contact in friends"
            :key="contact.contactUserId"
            class="group mb-1 flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2 transition-colors hover:border-accent/40"
          >
            <Avatar
              :name="contacts.displayName(contact)"
              :src="contact.user?.avatarUrl"
              :seed="contact.contactUserId"
              :size="38"
            />
            <button
              type="button"
              class="min-w-0 flex-1 text-left"
              :disabled="starting === contact.contactUserId"
              @click="openContact(contact)"
            >
              <p class="truncate text-[13.5px] font-medium text-text-strong">
                {{ contacts.displayName(contact) }}
                <span v-if="contact.alias && contact.user" class="ml-1 text-[11px] font-normal text-muted">
                  {{ contact.user.displayName }}
                </span>
              </p>
              <input
                v-if="editingId === contact.contactUserId"
                v-model="aliasDraft"
                class="mt-1 w-full rounded-md border border-line bg-surface-2 px-2 py-0.5 text-[12px] outline-none focus:border-accent"
                placeholder="备注名，回车保存"
                @click.stop
                @keydown.enter.prevent="commitRename(contact)"
                @keydown.esc.prevent="editingId = null"
              />
              <p v-else-if="subtitleOf(contact)" class="truncate text-[11.5px] text-muted">
                {{ subtitleOf(contact) }}
              </p>
            </button>
            <div
              class="flex items-center gap-0.5 transition-opacity"
              :class="ui.isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'"
            >
              <button
                type="button"
                class="rounded-md p-1 text-muted hover:bg-surface-3 hover:text-text"
                title="修改备注"
                @click.stop="beginRename(contact)"
              >
                <Icon name="edit" :size="13" />
              </button>
              <button
                type="button"
                class="rounded-md p-1 text-muted hover:bg-surface-3 hover:text-danger"
                title="从通讯录移除"
                @click.stop="removeContact(contact)"
              >
                <Icon name="close" :size="13" />
              </button>
            </div>
          </div>

          <div
            v-if="friends.length === 0"
            class="mt-4 rounded-xl border border-dashed border-line p-6 text-center"
          >
            <Icon name="users" :size="26" class="mx-auto mb-2 text-muted opacity-50" />
            <p class="text-[13px] text-text">还没有联系人</p>
            <p class="mt-1 text-[11.5px] text-muted">
              搜索用户名加好友，或在「设置 → AI 与模型」里创建角色
            </p>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
