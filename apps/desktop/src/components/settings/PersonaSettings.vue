<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { AiPersona, AiProvider } from '@nenochat/shared'
import Avatar from '@/components/ui/Avatar.vue'
import SettingsCard from '@/components/ui/form/SettingsCard.vue'
import Button from '@/components/ui/form/Button.vue'
import Alert from '@/components/ui/form/Alert.vue'
import ConfirmDialog from '@/components/ui/form/ConfirmDialog.vue'
import PersonaEditor from './PersonaEditor.vue'
import ProactiveSettings from './ProactiveSettings.vue'
import { aiApi } from '@/api/ai'
import { useAiStore } from '@/stores/ai'
import { useConversationsStore } from '@/stores/conversations'

const router = useRouter()
const conversations = useConversationsStore()
const ai = useAiStore()

const providers = ref<AiProvider[]>([])
const error = ref<string | null>(null)
const notice = ref<string | null>(null)

const showPersonaForm = ref(false)
const editingPersona = ref<AiPersona | null>(null)
const pendingRemovePersona = ref<AiPersona | null>(null)
const removingPersona = ref(false)

/** 角色列表以 ai store 为准，通讯录与消息分区读的是同一份 */
const personas = computed(() => ai.personas)
const hasProvider = computed(() => providers.value.length > 0)

/** 跟随全局的角色是否真的会主动发消息，要看那条总开关 */
function proactiveActive(persona: AiPersona): boolean {
  if (persona.proactiveMode === 'custom') return persona.proactive.enabled
  return ai.globalSettings?.proactiveEnabled ?? false
}

async function load(): Promise<void> {
  error.value = null
  try {
    // 角色编辑器与「新建角色」按钮都要用服务商列表，这里自己拉一份
    const providerResult = await aiApi.providers()
    providers.value = providerResult.providers
    await ai.load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取 AI 配置失败'
  }
}

function startCreate(): void {
  editingPersona.value = null
  showPersonaForm.value = true
}

function startEdit(persona: AiPersona): void {
  editingPersona.value = persona
  showPersonaForm.value = true
}

function closeEditor(): void {
  showPersonaForm.value = false
  editingPersona.value = null
}

async function onPersonaSaved(persona: AiPersona): Promise<void> {
  closeEditor()
  // 刚做过增改，store 的 loaded 守卫会跳过缓存，必须 force 才会真的回服务端拉
  await ai.load(true)
  // 新建角色会自动建会话，列表要立刻能看到
  await conversations.refresh().catch(() => undefined)
  notice.value = `已保存角色「${persona.name}」`
}

async function removePersona(): Promise<void> {
  const persona = pendingRemovePersona.value
  if (!persona) return
  error.value = null
  removingPersona.value = true
  try {
    await aiApi.deletePersona(persona.id)
    ai.removeLocal(persona.id)
    await conversations.refresh().catch(() => undefined)
    notice.value = '已删除角色'
  } catch (e) {
    error.value = e instanceof Error ? e.message : '删除失败'
  } finally {
    removingPersona.value = false
    pendingRemovePersona.value = null
  }
}

async function openChat(persona: AiPersona): Promise<void> {
  error.value = null
  try {
    const providerId = persona.providerId ?? providers.value[0]?.id
    if (!providerId) throw new Error('请先添加 AI 服务商')
    const result = await aiApi.openConversation({ personaId: persona.id, providerId })
    await conversations.refresh()
    await router.push(`/c/${result.conversation.id}`)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '无法打开 AI 会话'
  }
}

onMounted(() => {
  void load()
})
</script>

<template>
  <div class="space-y-3">
    <Alert v-if="error" tone="danger">{{ error }}</Alert>
    <Alert v-else-if="notice" tone="success">{{ notice }}</Alert>

    <SettingsCard
      id="personas"
      title="AI 角色"
      description="角色会出现在消息列表与通讯录里，人设、角色卡与兴趣都在角色编辑器里调整"
      icon="users"
    >
      <template #actions>
        <Button
          size="sm"
          icon="plus"
          :disabled="!hasProvider"
          :title="hasProvider ? '新建 AI 角色' : '请先添加服务商'"
          @click="startCreate"
        >
          新建角色
        </Button>
      </template>

      <PersonaEditor
        v-if="showPersonaForm"
        class="mb-3"
        :persona="editingPersona"
        :providers="providers"
        @saved="onPersonaSaved"
        @cancel="closeEditor"
      />

      <p v-if="personas.length === 0" class="py-2 text-[12px] text-muted">
        还没有 AI 角色，创建一个就会自动出现在消息列表与通讯录里。
      </p>

      <div v-else class="space-y-2">
        <div
          v-for="persona in personas"
          :key="persona.id"
          class="flex items-center gap-2.5 rounded-lg border border-line bg-surface-2 px-3 py-2"
        >
          <Avatar :name="persona.name" :src="persona.avatarUrl" :seed="persona.id" :size="34" />
          <div class="min-w-0 flex-1">
            <p class="flex flex-wrap items-center gap-1.5 truncate text-[12.5px] font-medium text-text-strong">
              {{ persona.name }}
              <span
                v-if="proactiveActive(persona)"
                class="rounded bg-accent/12 px-1 text-[10px] font-normal text-accent"
              >
                主动消息
              </span>
              <span
                v-if="persona.proactiveMode === 'global'"
                class="rounded bg-surface px-1 text-[10px] font-normal text-muted"
              >
                跟随全局
              </span>
            </p>
            <p class="truncate text-[11px] text-muted">
              {{ persona.interests.length > 0 ? persona.interests.join(' · ') : persona.systemPrompt.slice(0, 36) }}
            </p>
          </div>
          <Button size="sm" variant="primary" @click="openChat(persona)">聊天</Button>
          <Button
            variant="ghost"
            size="sm"
            icon="edit"
            title="编辑角色"
            aria-label="编辑角色"
            @click="startEdit(persona)"
          />
          <Button
            variant="ghost"
            size="sm"
            icon="trash"
            class="hover:!bg-danger/10 hover:!text-danger"
            title="删除角色"
            aria-label="删除角色"
            @click="pendingRemovePersona = persona"
          />
        </div>
      </div>
    </SettingsCard>

    <ProactiveSettings />

    <ConfirmDialog
      :open="Boolean(pendingRemovePersona)"
      title="删除这个 AI 角色？"
      :description="`「${pendingRemovePersona?.name ?? ''}」的聊天记录会一起移除，此操作不可撤销。`"
      confirm-text="删除角色"
      :loading="removingPersona"
      @update:open="(value) => !value && (pendingRemovePersona = null)"
      @confirm="removePersona"
    />
  </div>
</template>
