<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { AiPersona, PublicUser } from '@nenochat/shared'
import Avatar from '@/components/ui/Avatar.vue'
import Icon from '@/components/ui/Icon.vue'
import { conversationApi, userApi } from '@/api/endpoints'
import { aiApi } from '@/api/ai'
import { useAiStore } from '@/stores/ai'
import { useConversationsStore } from '@/stores/conversations'

const emit = defineEmits<{ (e: 'close'): void; (e: 'created', conversationId: string): void }>()

const conversations = useConversationsStore()
const ai = useAiStore()

interface Pickable {
  id: string
  name: string
  avatarUrl?: string | null
  username?: string
  seed: string
}

const mode = ref<'direct' | 'group' | 'ai'>('direct')
const keyword = ref('')
const results = ref<PublicUser[]>([])
const selected = ref<Pickable[]>([])
const groupName = ref('')
const busy = ref(false)
const error = ref<string | null>(null)

onMounted(() => {
  void ai.load()
})

let searchTimer: ReturnType<typeof setTimeout> | null = null

watch(keyword, (value) => {
  if (searchTimer) clearTimeout(searchTimer)
  const q = value.trim()
  if (q.length === 0) {
    results.value = []
    return
  }
  searchTimer = setTimeout(async () => {
    try {
      const found = await userApi.search(q)
      results.value = found.users
    } catch {
      results.value = []
    }
  }, 260)
})

const isSelected = (id: string): boolean => selected.value.some((u) => u.id === id)

function toggle(user: PublicUser): void {
  togglePickable({
    id: user.id,
    name: user.displayName,
    avatarUrl: user.avatarUrl,
    username: user.username,
    seed: user.id,
  })
}

/** 群聊也能拉 AI：角色在服务端就是 users 表里的影子账号 */
function togglePersona(persona: AiPersona): void {
  if (!persona.userId) return
  togglePickable({
    id: persona.userId,
    name: persona.name,
    avatarUrl: persona.avatarUrl,
    seed: persona.id,
  })
}

function togglePickable(candidate: Pickable): void {
  if (mode.value === 'direct') {
    selected.value = [candidate]
    return
  }
  if (isSelected(candidate.id)) {
    selected.value = selected.value.filter((u) => u.id !== candidate.id)
  } else {
    selected.value = [...selected.value, candidate]
  }
}

const groupPersonas = computed(() => ai.personas.filter((persona) => Boolean(persona.userId)))

const canSubmit = computed(() => {
  if (busy.value) return false
  if (mode.value === 'ai') return false
  if (mode.value === 'direct') return selected.value.length === 1
  return groupName.value.trim().length > 0 && selected.value.length > 0
})

/** AI 角色不需要「先选再提交」，点一下就进会话 */
async function openPersona(persona: AiPersona): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = null
  try {
    const result = await aiApi.openConversation({
      personaId: persona.id,
      providerId: persona.providerId ?? undefined,
    })
    await conversations.refresh()
    emit('created', result.conversation.id)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '无法打开会话'
  } finally {
    busy.value = false
  }
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return
  busy.value = true
  error.value = null
  try {
    if (mode.value === 'direct') {
      const result = await conversationApi.create({
        type: 'direct',
        targetUserId: selected.value[0]!.id,
      })
      await conversations.refresh()
      emit('created', result.conversation.id)
      return
    }

    const result = await conversationApi.create({
      type: 'group',
      name: groupName.value.trim(),
      memberIds: selected.value.map((u) => u.id),
    })
    await conversations.refresh()
    emit('created', result.conversation.id)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '创建失败'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 md:grid md:place-items-center md:p-6"
      @click.self="emit('close')"
    >
      <div
        class="animate-fade-up flex max-h-[90dvh] w-full max-w-md flex-col overflow-hidden rounded-t-2xl border border-line bg-surface shadow-[var(--shadow-soft)] md:rounded-2xl"
      >
        <header
          class="flex shrink-0 items-center justify-between border-b border-line px-4 pb-3 pt-[calc(0.75rem+var(--safe-top))] md:py-3"
        >
          <h2 class="text-[15px] font-semibold text-text-strong">发起新会话</h2>
          <button
            type="button"
            class="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-text"
            @click="emit('close')"
          >
            <Icon name="close" :size="16" />
          </button>
        </header>

        <div class="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-4 py-2">
          <button
            v-for="tab in [
              { key: 'direct', label: '私聊' },
              { key: 'group', label: '群聊' },
              { key: 'ai', label: 'AI 角色' },
            ]"
            :key="tab.key"
            type="button"
            class="rounded-lg px-3 py-1 text-[13px] transition-colors"
            :class="
              mode === tab.key ? 'bg-accent text-accent-text' : 'text-muted hover:bg-surface-2'
            "
            @click="
              mode = tab.key as 'direct' | 'group' | 'ai';
              selected = [];
              keyword = '';
              groupName = ''
            "
          >
            {{ tab.label }}
          </button>
        </div>

        <div v-if="mode === 'ai'" class="min-h-0 flex-1 space-y-1 overflow-y-auto px-4 py-3">
          <p v-if="ai.personas.length === 0" class="py-6 text-center text-[12.5px] text-muted">
            还没有角色，先到「设置 → AI 与模型」创建一个
          </p>
          <button
            v-for="persona in ai.personas"
            :key="persona.id"
            type="button"
            class="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-2 disabled:opacity-60"
            :disabled="busy"
            @click="openPersona(persona)"
          >
            <Avatar :name="persona.name" :src="persona.avatarUrl" :seed="persona.id" :size="30" />
            <div class="min-w-0 flex-1">
              <p class="truncate text-[13px] text-text-strong">{{ persona.name }}</p>
              <p class="truncate text-[11px] text-muted">
                {{ persona.interests.slice(0, 3).join(' · ') || persona.systemPrompt.slice(0, 30) }}
              </p>
            </div>
            <Icon name="chevronRight" :size="14" class="text-muted" />
          </button>
          <p v-if="error" class="text-[12.5px] text-danger">{{ error }}</p>
        </div>

        <div v-else class="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          <input
            v-if="mode === 'group'"
            v-model="groupName"
            type="text"
            placeholder="群聊名称"
            class="h-9 w-full rounded-lg border border-line bg-surface-2 px-3 text-[13px] outline-none focus:border-accent"
          />

          <div class="relative">
            <span class="absolute top-1/2 left-2.5 -translate-y-1/2 text-muted">
              <Icon name="search" :size="15" />
            </span>
            <input
              v-model="keyword"
              type="text"
              placeholder="搜索用户名或昵称"
              class="h-9 w-full rounded-lg border border-line bg-surface-2 pl-8 pr-3 text-[13px] outline-none focus:border-accent"
            />
          </div>

          <div
            v-if="selected.length > 0"
            class="flex flex-wrap gap-1.5 rounded-lg bg-surface-2 p-2"
          >
            <span
              v-for="user in selected"
              :key="user.id"
              class="flex items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-[12px]"
            >
              {{ user.name }}
              <button type="button" class="text-muted hover:text-danger" @click="togglePickable(user)">
                <Icon name="close" :size="11" />
              </button>
            </span>
          </div>

          <div class="scroll-area max-h-56 space-y-0.5">
            <button
              v-for="user in results"
              :key="user.id"
              type="button"
              class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-2"
              @click="toggle(user)"
            >
              <Avatar :name="user.displayName" :src="user.avatarUrl" :seed="user.id" :size="28" />
              <div class="min-w-0 flex-1">
                <p class="truncate text-[13px] text-text-strong">{{ user.displayName }}</p>
                <p class="truncate text-[11px] text-muted">@{{ user.username }}</p>
              </div>
              <Icon
                v-if="isSelected(user.id)"
                name="check"
                :size="15"
                class="text-accent"
              />
            </button>

            <p v-if="keyword && results.length === 0" class="py-6 text-center text-[12.5px] text-muted">
              没有找到用户
            </p>
            <p v-if="!keyword" class="py-6 text-center text-[12.5px] text-muted">
              {{ mode === 'group' ? '搜索好友，或从下面挑一个 AI 角色' : '输入用户名搜索，例如 alice' }}
            </p>

            <div v-if="mode === 'group'" class="mt-1 border-t border-line pt-2">
              <p class="px-2 pb-1 text-[11px] font-medium tracking-wide text-muted">我的 AI 角色</p>
              <p v-if="groupPersonas.length === 0" class="px-2 py-2 text-[12px] text-muted">
                还没有 AI 角色
              </p>
              <button
                v-for="persona in groupPersonas"
                :key="persona.id"
                type="button"
                class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-2"
                @click="togglePersona(persona)"
              >
                <Avatar :name="persona.name" :src="persona.avatarUrl" :seed="persona.id" :size="28" />
                <div class="min-w-0 flex-1">
                  <p class="truncate text-[13px] text-text-strong">{{ persona.name }}</p>
                  <p class="truncate text-[11px] text-muted">
                    {{ persona.interests.slice(0, 3).join(' · ') || '会按自己的心情决定要不要接话' }}
                  </p>
                </div>
                <Icon
                  v-if="isSelected(persona.userId!)"
                  name="check"
                  :size="15"
                  class="text-accent"
                />
              </button>
            </div>
          </div>

          <p v-if="error" class="text-[12.5px] text-danger">{{ error }}</p>
        </div>

        <footer
          class="flex shrink-0 justify-end gap-2 border-t border-line px-4 pt-3 pb-[calc(0.75rem+var(--safe-bottom))] md:pb-3"
        >
          <button
            type="button"
            class="rounded-lg px-3 py-1.5 text-[13px] text-muted hover:bg-surface-2"
            @click="emit('close')"
          >
            {{ mode === 'ai' ? '关闭' : '取消' }}
          </button>
          <button
            v-if="mode !== 'ai'"
            type="button"
            class="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-text disabled:opacity-50"
            :disabled="!canSubmit"
            @click="submit"
          >
            {{ busy ? '创建中…' : '创建' }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
