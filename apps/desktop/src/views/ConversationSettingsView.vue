<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { AiPersona, Conversation, Member, PublicUser } from '@nenochat/shared'
import Avatar from '@/components/ui/Avatar.vue'
import AvatarUploader from '@/components/settings/AvatarUploader.vue'
import PersonaEditor from '@/components/settings/PersonaEditor.vue'
import Icon from '@/components/ui/Icon.vue'
import { conversationApi, userApi } from '@/api/endpoints'
import { useAiStore } from '@/stores/ai'
import { useConversationsStore } from '@/stores/conversations'
import { useMembersStore } from '@/stores/members'

interface MemberWithUser extends Member {
  user: PublicUser | null
}

interface Detail {
  conversation: Conversation
  me: Member
  members: MemberWithUser[]
}

const route = useRoute()
const router = useRouter()
const conversations = useConversationsStore()
const members = useMembersStore()
const ai = useAiStore()

const conversationId = computed(() => String(route.params.conversationId ?? ''))
const detail = ref<Detail | null>(null)
const loading = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)

const name = ref('')
const announcement = ref('')
const avatarUrl = ref<string | null>(null)

const addKeyword = ref('')
const addResults = ref<PublicUser[]>([])
const addSelected = ref<Array<{ id: string; name: string; avatarUrl?: string | null; seed: string }>>([])
const adding = ref(false)

const transferOpen = ref(false)
const dissolveArmed = ref(false)

const me = computed(() => detail.value?.me ?? null)
const isOwner = computed(() => me.value?.role === 'owner')
const isAdmin = computed(() => me.value?.role === 'admin')
const canManage = computed(() => isOwner.value || isAdmin.value)
const isGroup = computed(() => detail.value?.conversation.type === 'group')
const isAiConversation = computed(() => detail.value?.conversation.type === 'ai')

/** 会话标题：群聊是「群设置」，AI 会话是「AI 设置」 */
const pageTitle = computed(() => {
  if (isAiConversation.value) return 'AI 设置'
  if (isGroup.value) return '群设置'
  return '会话设置'
})

/** 会话里直接改角色：改的是全局 persona，它参与的所有会话同步生效 */
const editingPersona = computed<AiPersona | null>(() => ai.personaOf(conversationId.value) ?? null)
const personaProviders = computed(() => ai.providers)

async function onPersonaSaved(persona: AiPersona): Promise<void> {
  ai.upsertLocal(persona)
  await conversations.refresh().catch(() => undefined)
  notice.value = `已保存角色「${persona.name}」，它参与的所有会话都会生效`
}

const personaByUserId = computed(() => {
  const map = new Map<string, AiPersona>()
  for (const persona of ai.personas) {
    if (persona.userId) map.set(persona.userId, persona)
  }
  return map
})

const memberUserIds = computed(() => new Set(detail.value?.members.map((m) => m.userId) ?? []))
const addablePersonas = computed(() =>
  ai.personas.filter((persona) => persona.userId && !memberUserIds.value.has(persona.userId)),
)
const transferCandidates = computed(
  () =>
    detail.value?.members.filter(
      (m) => m.userId !== me.value?.userId && !personaByUserId.value.has(m.userId),
    ) ?? [],
)

async function load(): Promise<void> {
  if (!conversationId.value) return
  loading.value = true
  error.value = null
  try {
    const result = await conversationApi.detail(conversationId.value)
    detail.value = { conversation: result.conversation, me: result.me, members: result.members }
    name.value = result.conversation.name ?? ''
    announcement.value = result.conversation.announcement ?? ''
    avatarUrl.value = result.conversation.avatarUrl ?? null
    await members.load(conversationId.value, true)
    void ai.load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载群资料失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(conversationId, load)

async function saveInfo(): Promise<void> {
  if (saving.value) return
  saving.value = true
  error.value = null
  notice.value = null
  try {
    const result = await conversationApi.update(conversationId.value, {
      name: name.value.trim(),
      announcement: announcement.value.trim() ? announcement.value.trim() : null,
      avatarUrl: avatarUrl.value,
    })
    if (detail.value) detail.value.conversation = result.conversation
    await conversations.refresh()
    notice.value = '已保存'
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    saving.value = false
  }
}

async function onAvatarUploaded(url: string): Promise<void> {
  avatarUrl.value = url
  await saveInfo()
}

let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(addKeyword, (value) => {
  if (searchTimer) clearTimeout(searchTimer)
  const query = value.trim()
  if (!query) {
    addResults.value = []
    return
  }
  searchTimer = setTimeout(async () => {
    try {
      const found = await userApi.search(query)
      addResults.value = found.users.filter((user) => !memberUserIds.value.has(user.id))
    } catch {
      addResults.value = []
    }
  }, 260)
})

function togglePickable(candidate: { id: string; name: string; avatarUrl?: string | null; seed: string }): void {
  const exists = addSelected.value.some((item) => item.id === candidate.id)
  addSelected.value = exists
    ? addSelected.value.filter((item) => item.id !== candidate.id)
    : [...addSelected.value, candidate]
}

function toggleUser(user: PublicUser): void {
  togglePickable({ id: user.id, name: user.displayName, avatarUrl: user.avatarUrl, seed: user.id })
}

function togglePersona(persona: AiPersona): void {
  if (!persona.userId) return
  togglePickable({ id: persona.userId, name: persona.name, avatarUrl: persona.avatarUrl, seed: persona.id })
}

async function addMembers(): Promise<void> {
  if (addSelected.value.length === 0 || adding.value) return
  adding.value = true
  error.value = null
  try {
    await conversationApi.addMembers(
      conversationId.value,
      addSelected.value.map((item) => item.id),
    )
    addSelected.value = []
    addKeyword.value = ''
    addResults.value = []
    await load()
    await conversations.refresh()
    notice.value = '已添加成员'
  } catch (e) {
    error.value = e instanceof Error ? e.message : '添加失败'
  } finally {
    adding.value = false
  }
}

async function setRole(member: MemberWithUser, role: 'member' | 'admin'): Promise<void> {
  error.value = null
  try {
    await conversationApi.updateMember(conversationId.value, member.userId, { role })
    await members.load(conversationId.value, true)
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '修改失败'
  }
}

async function toggleMute(member: MemberWithUser): Promise<void> {
  error.value = null
  try {
    const muted = member.muteUntil && member.muteUntil > Date.now()
    await conversationApi.updateMember(conversationId.value, member.userId, {
      muteUntil: muted ? null : Date.now() + 60 * 60 * 1000,
    })
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '操作失败'
  }
}

async function kick(member: MemberWithUser): Promise<void> {
  error.value = null
  try {
    await conversationApi.removeMember(conversationId.value, member.userId)
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '移除失败'
  }
}

async function transferTo(member: MemberWithUser): Promise<void> {
  error.value = null
  transferOpen.value = false
  try {
    await conversationApi.transfer(conversationId.value, member.userId)
    await load()
    notice.value = '已转让群主'
  } catch (e) {
    error.value = e instanceof Error ? e.message : '转让失败'
  }
}

async function dissolve(): Promise<void> {
  if (!dissolveArmed.value) {
    dissolveArmed.value = true
    return
  }
  error.value = null
  try {
    await conversationApi.dissolve(conversationId.value)
    conversations.remove(conversationId.value)
    void router.replace('/')
  } catch (e) {
    error.value = e instanceof Error ? e.message : '解散失败'
  }
}

async function leave(): Promise<void> {
  error.value = null
  try {
    await conversationApi.removeMember(conversationId.value, me.value?.userId ?? '')
    conversations.remove(conversationId.value)
    void router.replace('/')
  } catch (e) {
    error.value = e instanceof Error ? e.message : '退出失败'
  }
}

function displayName(member: MemberWithUser): string {
  return member.nickname || member.user?.displayName || member.userId
}

function backToChat(): void {
  void router.push(`/c/${conversationId.value}`)
}
</script>

<template>
  <div class="flex h-full flex-col">
    <header
      class="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3"
      data-tauri-drag-region
    >
      <button type="button" class="rounded-md p-1 text-muted hover:bg-surface-2" @click="backToChat">
        <Icon name="arrowLeft" :size="18" />
      </button>
      <h1 class="text-[14px] font-semibold text-text-strong">{{ pageTitle }}</h1>
    </header>

    <div class="scroll-area flex-1 px-5 py-5">
      <div class="mx-auto max-w-2xl space-y-4">
        <p v-if="error" class="text-[12px] text-danger">{{ error }}</p>
        <p v-else-if="notice" class="text-[12px] text-accent">{{ notice }}</p>

        <p v-if="loading && !detail" class="py-10 text-center text-[12px] text-muted">加载中…</p>

        <template v-else-if="detail">
          <!-- AI 会话：直接编辑角色，提示词、角色卡、兴趣在这里改完全局生效 -->
          <template v-if="isAiConversation">
            <p v-if="editingPersona" class="rounded-xl border border-line bg-surface p-3 text-[11.5px] leading-relaxed text-muted">
              这里改的是 AI 角色「{{ editingPersona.name }}」本身，保存后它参与的私聊与群聊都会生效。
              想让它发表情包，到「设置 → 表情包」给分组开启「允许 AI 使用」。
            </p>
            <PersonaEditor
              v-if="editingPersona"
              :persona="editingPersona"
              :providers="personaProviders"
              @saved="onPersonaSaved"
              @cancel="backToChat"
            />
            <section v-else class="rounded-xl border border-dashed border-line p-6 text-center">
              <p class="text-[13px] text-text">这个会话还没有绑定 AI 角色</p>
            </section>
          </template>

          <section v-else-if="!isGroup" class="rounded-xl border border-dashed border-line p-6 text-center">
            <p class="text-[13px] text-text">这里是群设置</p>
            <p class="mt-1 text-[11.5px] text-muted">私聊资料请到「设置」里修改</p>
          </section>

          <template v-else>
            <!-- 群资料 -->
            <section class="rounded-xl border border-line bg-surface p-4">
              <div class="flex items-start gap-4">
                <AvatarUploader
                  :src="avatarUrl"
                  :name="name || detail.conversation.name"
                  :size="60"
                  hint="建议方形图片"
                  :disabled="!canManage"
                  @uploaded="onAvatarUploaded"
                />
                <div class="min-w-0 flex-1">
                  <label class="mb-1 block text-[11px] font-medium tracking-wide text-muted">
                    群名称
                  </label>
                  <input
                    v-model="name"
                    type="text"
                    maxlength="64"
                    :disabled="!canManage"
                    class="h-9 w-full rounded-lg border border-line bg-surface-2 px-3 text-[13.5px] outline-none focus:border-accent disabled:opacity-60"
                  />
                </div>
              </div>

              <label class="mt-4 mb-1 block text-[11px] font-medium tracking-wide text-muted">
                群公告
              </label>
              <textarea
                v-model="announcement"
                rows="4"
                maxlength="4000"
                :disabled="!canManage"
                placeholder="拉 AI 进群后，它也会看到群公告"
                class="w-full resize-none rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] outline-none focus:border-accent disabled:opacity-60"
              ></textarea>

              <div class="mt-3 flex items-center justify-between">
                <p class="text-[11.5px] text-muted">
                  {{ detail.members.length }} 位成员 · 群主可管理权限
                </p>
                <button
                  type="button"
                  class="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-accent-text disabled:opacity-50"
                  :disabled="!canManage || saving"
                  @click="saveInfo"
                >
                  {{ saving ? '保存中…' : '保存' }}
                </button>
              </div>
            </section>

            <!-- 成员 -->
            <section class="rounded-xl border border-line bg-surface p-4">
              <div class="mb-2 flex items-center justify-between">
                <p class="text-[13px] font-medium text-text-strong">成员</p>
                <p class="text-[11.5px] text-muted">{{ detail.members.length }} 人</p>
              </div>

              <div
                v-for="member in detail.members"
                :key="member.userId"
                class="mb-1 flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-surface-2"
              >
                <Avatar
                  :name="displayName(member)"
                  :src="member.user?.avatarUrl"
                  :seed="member.userId"
                  :size="34"
                />
                <div class="min-w-0 flex-1">
                  <p class="truncate text-[13px] text-text-strong">
                    {{ displayName(member) }}
                    <span v-if="member.role === 'owner'" class="ml-1 text-[10.5px] text-accent">群主</span>
                    <span v-else-if="member.role === 'admin'" class="ml-1 text-[10.5px] text-muted">管理员</span>
                    <span
                      v-if="personaByUserId.has(member.userId)"
                      class="ml-1 rounded bg-mention-soft px-1 py-0.5 text-[9.5px] text-mention"
                    >
                      AI
                    </span>
                  </p>
                  <p class="truncate text-[11px] text-muted">
                    <template v-if="member.muteUntil && member.muteUntil > Date.now()">已禁言</template>
                    <template v-else>{{ member.user?.bio || (personaByUserId.has(member.userId) ? '会按自己的心情接话' : '') }}</template>
                  </p>
                </div>

                <div v-if="canManage && member.userId !== me?.userId" class="flex items-center gap-0.5">
                  <button
                    v-if="isOwner && member.role === 'member'"
                    type="button"
                    class="rounded-md px-1.5 py-1 text-[11px] text-muted hover:bg-surface-3 hover:text-text"
                    @click="setRole(member, 'admin')"
                  >
                    设为管理员
                  </button>
                  <button
                    v-else-if="isOwner && member.role === 'admin'"
                    type="button"
                    class="rounded-md px-1.5 py-1 text-[11px] text-muted hover:bg-surface-3 hover:text-text"
                    @click="setRole(member, 'member')"
                  >
                    取消管理员
                  </button>
                  <button
                    type="button"
                    class="rounded-md px-1.5 py-1 text-[11px] text-muted hover:bg-surface-3 hover:text-text"
                    @click="toggleMute(member)"
                  >
                    {{ member.muteUntil && member.muteUntil > Date.now() ? '解除禁言' : '禁言 1 小时' }}
                  </button>
                  <button
                    type="button"
                    class="rounded-md p-1 text-muted hover:bg-surface-3 hover:text-danger"
                    title="移出群聊"
                    @click="kick(member)"
                  >
                    <Icon name="close" :size="13" />
                  </button>
                </div>
              </div>
            </section>

            <!-- 添加成员 -->
            <section v-if="canManage" class="rounded-xl border border-line bg-surface p-4">
              <p class="mb-2 text-[13px] font-medium text-text-strong">添加成员</p>
              <div class="relative">
                <span class="absolute top-1/2 left-3 -translate-y-1/2 text-muted">
                  <Icon name="search" :size="15" />
                </span>
                <input
                  v-model="addKeyword"
                  type="search"
                  placeholder="搜索好友"
                  class="h-9 w-full rounded-lg border border-line bg-surface-2 pl-8 pr-3 text-[13px] outline-none focus:border-accent"
                />
              </div>

              <div v-if="addSelected.length > 0" class="mt-2 flex flex-wrap gap-1.5">
                <span
                  v-for="item in addSelected"
                  :key="item.id"
                  class="flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[12px]"
                >
                  {{ item.name }}
                  <button type="button" class="text-muted hover:text-danger" @click="togglePickable(item)">
                    <Icon name="close" :size="11" />
                  </button>
                </span>
              </div>

              <div v-if="addKeyword" class="mt-2 max-h-40 space-y-0.5 overflow-auto">
                <p v-if="addResults.length === 0" class="py-2 text-center text-[12px] text-muted">
                  没有找到用户
                </p>
                <button
                  v-for="user in addResults"
                  :key="user.id"
                  type="button"
                  class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface-2"
                  @click="toggleUser(user)"
                >
                  <Avatar :name="user.displayName" :src="user.avatarUrl" :seed="user.id" :size="26" />
                  <span class="min-w-0 flex-1 truncate text-[13px] text-text-strong">
                    {{ user.displayName }}
                  </span>
                  <Icon v-if="addSelected.some((item) => item.id === user.id)" name="check" :size="14" class="text-accent" />
                </button>
              </div>

              <template v-if="addablePersonas.length > 0">
                <p class="mt-3 mb-1 text-[11px] font-medium tracking-wide text-muted">我的 AI 角色</p>
                <button
                  v-for="persona in addablePersonas"
                  :key="persona.id"
                  type="button"
                  class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface-2"
                  @click="togglePersona(persona)"
                >
                  <Avatar :name="persona.name" :src="persona.avatarUrl" :seed="persona.id" :size="26" />
                  <span class="min-w-0 flex-1 truncate text-[13px] text-text-strong">
                    {{ persona.name }}
                  </span>
                  <Icon
                    v-if="persona.userId && addSelected.some((item) => item.id === persona.userId)"
                    name="check"
                    :size="14"
                    class="text-accent"
                  />
                </button>
              </template>

              <button
                type="button"
                class="mt-3 w-full rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-accent-text disabled:opacity-50"
                :disabled="addSelected.length === 0 || adding"
                @click="addMembers"
              >
                {{ adding ? '添加中…' : `添加 ${addSelected.length || ''} 位成员` }}
              </button>
            </section>

            <!-- 危险操作 -->
            <section class="rounded-xl border border-line bg-surface p-4">
              <p class="mb-2 text-[13px] font-medium text-text-strong">群管理</p>

              <div v-if="isOwner" class="space-y-2">
                <button
                  type="button"
                  class="flex w-full items-center justify-between rounded-lg border border-line px-3 py-2 text-[13px] text-text hover:bg-surface-2"
                  @click="transferOpen = !transferOpen"
                >
                  转让群主
                  <Icon name="chevronDown" :size="14" />
                </button>
                <div v-if="transferOpen" class="rounded-lg bg-surface-2 p-1">
                  <p v-if="transferCandidates.length === 0" class="px-2 py-2 text-[12px] text-muted">
                    群里还没有其他真人成员
                  </p>
                  <button
                    v-for="member in transferCandidates"
                    :key="member.userId"
                    type="button"
                    class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface"
                    @click="transferTo(member)"
                  >
                    <Avatar :name="displayName(member)" :src="member.user?.avatarUrl" :seed="member.userId" :size="24" />
                    <span class="truncate text-[12.5px] text-text">{{ displayName(member) }}</span>
                  </button>
                </div>

                <button
                  type="button"
                  class="w-full rounded-lg border border-danger/40 px-3 py-2 text-[13px] text-danger hover:bg-danger/10"
                  @click="dissolve"
                >
                  {{ dissolveArmed ? '再点一次确认解散（不可恢复）' : '解散群聊' }}
                </button>
              </div>

              <button
                v-else
                type="button"
                class="w-full rounded-lg border border-line px-3 py-2 text-[13px] text-text hover:bg-surface-2"
                @click="leave"
              >
                退出群聊
              </button>
            </section>
          </template>
        </template>
      </div>
    </div>
  </div>
</template>
