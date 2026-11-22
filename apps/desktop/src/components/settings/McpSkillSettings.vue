<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { McpServer, Skill } from '@nenochat/shared'
import SettingsCard from '@/components/ui/form/SettingsCard.vue'
import Field from '@/components/ui/form/Field.vue'
import TextInput from '@/components/ui/form/TextInput.vue'
import Textarea from '@/components/ui/form/Textarea.vue'
import NumberInput from '@/components/ui/form/NumberInput.vue'
import Button from '@/components/ui/form/Button.vue'
import Switch from '@/components/ui/form/Switch.vue'
import Alert from '@/components/ui/form/Alert.vue'
import ConfirmDialog from '@/components/ui/form/ConfirmDialog.vue'
import { mcpApi } from '@/api/mcp'
import { skillApi } from '@/api/skills'

const servers = ref<McpServer[]>([])
const skills = ref<Skill[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)

/* ------------------------------ MCP 服务器 ------------------------------ */

const mcpEditingId = ref<string | null>(null)
const mcpFormOpen = ref(false)
const mcpSaving = ref(false)
const mcpTestingId = ref<string | null>(null)
const mcpTogglingId = ref<string | null>(null)
const pendingRemoveServer = ref<McpServer | null>(null)
const removingServer = ref(false)

const mcpForm = ref({
  name: '',
  url: '',
  timeoutMs: null as number | null,
  headers: [] as Array<{ key: string; value: string }>,
})

const mcpEditing = (): McpServer | null =>
  mcpEditingId.value ? (servers.value.find((item) => item.id === mcpEditingId.value) ?? null) : null

async function load(): Promise<void> {
  loading.value = true
  try {
    const [mcpResult, skillResult] = await Promise.all([mcpApi.list(), skillApi.list()])
    servers.value = mcpResult.servers
    skills.value = skillResult.skills
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取 MCP 与技能失败'
  } finally {
    loading.value = false
  }
}

function openMcpForm(server: McpServer | null): void {
  mcpEditingId.value = server?.id ?? null
  mcpFormOpen.value = true
  mcpForm.value = {
    name: server?.name ?? '',
    url: server?.url ?? '',
    timeoutMs: server?.config.timeoutMs ?? null,
    headers: Object.entries(server?.secretMasked.headers ?? {}).map(([key]) => ({ key, value: '' })),
  }
  error.value = null
  notice.value = null
}

function closeMcpForm(): void {
  mcpEditingId.value = null
  mcpFormOpen.value = false
}

function addHeaderRow(): void {
  mcpForm.value.headers.push({ key: '', value: '' })
}

function removeHeaderRow(index: number): void {
  mcpForm.value.headers.splice(index, 1)
}

async function saveMcp(): Promise<void> {
  error.value = null
  notice.value = null
  const name = mcpForm.value.name.trim()
  const url = mcpForm.value.url.trim()
  if (!name) {
    error.value = '给 MCP 服务器起个名字'
    return
  }
  if (!url) {
    error.value = '请填写 MCP 端点地址'
    return
  }

  // 有值的行才收集；编辑时 value 留空表示保持原值
  const headers: Record<string, string> = {}
  for (const row of mcpForm.value.headers) {
    const key = row.key.trim()
    const value = row.value.trim()
    if (key && value) headers[key] = value
  }
  const config = { timeoutMs: mcpForm.value.timeoutMs }

  mcpSaving.value = true
  try {
    if (mcpEditingId.value) {
      const result = await mcpApi.update(mcpEditingId.value, {
        name,
        url,
        config,
        ...(Object.keys(headers).length > 0 ? { secret: { headers } } : {}),
      })
      replaceServer(result.server)
    } else {
      const result = await mcpApi.create({ name, url, enabled: true, config, secret: { headers } })
      servers.value.push(result.server)
    }
    closeMcpForm()
    notice.value = `${name} 已保存`
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存 MCP 服务器失败'
  } finally {
    mcpSaving.value = false
  }
}

function replaceServer(next: McpServer): void {
  const index = servers.value.findIndex((item) => item.id === next.id)
  if (index >= 0) servers.value[index] = next
  else servers.value.push(next)
}

async function toggleServer(server: McpServer, enabled: boolean): Promise<void> {
  error.value = null
  mcpTogglingId.value = server.id
  try {
    const result = await mcpApi.update(server.id, { enabled })
    replaceServer(result.server)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '切换状态失败'
  } finally {
    mcpTogglingId.value = null
  }
}

async function testServer(server: McpServer): Promise<void> {
  error.value = null
  notice.value = null
  mcpTestingId.value = server.id
  try {
    const result = await mcpApi.test(server.id)
    await load()
    if (result.result.ok) notice.value = `${server.name}：${result.result.message}`
    else error.value = `${server.name}：${result.result.message}`
  } catch (e) {
    error.value = e instanceof Error ? e.message : '测试失败'
  } finally {
    mcpTestingId.value = null
  }
}

async function removeServer(): Promise<void> {
  const target = pendingRemoveServer.value
  if (!target) return
  removingServer.value = true
  error.value = null
  try {
    await mcpApi.remove(target.id)
    servers.value = servers.value.filter((item) => item.id !== target.id)
    if (mcpEditingId.value === target.id) closeMcpForm()
    pendingRemoveServer.value = null
    notice.value = 'MCP 服务器已删除'
  } catch (e) {
    error.value = e instanceof Error ? e.message : '删除失败'
  } finally {
    removingServer.value = false
  }
}

function savedHeadersText(server: McpServer): string {
  const entries = Object.entries(server.secretMasked.headers ?? {})
  if (entries.length === 0) return ''
  return entries.map(([key, value]) => `${key}: ${value}`).join('、')
}

function lastTestText(server: McpServer): string {
  if (server.lastTestAt === null || server.lastTestAt === undefined) return '还没有测试过'
  const time = new Date(server.lastTestAt)
  const stamp = `${time.getMonth() + 1}/${time.getDate()} ${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
  const result = server.lastTestOk ? '通过' : '失败'
  return `上次测试 ${stamp} · ${result}${server.lastTestMessage ? `：${server.lastTestMessage}` : ''}`
}

/* -------------------------------- 技能 -------------------------------- */

const skillEditingId = ref<string | null>(null)
const skillFormOpen = ref(false)
const skillSaving = ref(false)
const skillTogglingId = ref<string | null>(null)
const pendingRemoveSkill = ref<Skill | null>(null)
const removingSkill = ref(false)

const skillForm = ref({
  name: '',
  description: '',
  content: '',
  enabled: true,
})

const skillEditing = (): Skill | null =>
  skillEditingId.value ? (skills.value.find((item) => item.id === skillEditingId.value) ?? null) : null

function openSkillForm(skill: Skill | null): void {
  skillEditingId.value = skill?.id ?? null
  skillFormOpen.value = true
  skillForm.value = {
    name: skill?.name ?? '',
    description: skill?.description ?? '',
    content: skill?.content ?? '',
    enabled: skill?.enabled ?? true,
  }
  error.value = null
  notice.value = null
}

function closeSkillForm(): void {
  skillEditingId.value = null
  skillFormOpen.value = false
}

async function saveSkill(): Promise<void> {
  error.value = null
  notice.value = null
  const name = skillForm.value.name.trim()
  if (!name) {
    error.value = '给技能起个名字'
    return
  }

  skillSaving.value = true
  try {
    if (skillEditingId.value) {
      const result = await skillApi.update(skillEditingId.value, {
        name,
        description: skillForm.value.description.trim(),
        content: skillForm.value.content,
        enabled: skillForm.value.enabled,
      })
      replaceSkill(result.skill)
    } else {
      const result = await skillApi.create({
        name,
        description: skillForm.value.description.trim(),
        content: skillForm.value.content,
        enabled: skillForm.value.enabled,
      })
      skills.value.push(result.skill)
    }
    closeSkillForm()
    notice.value = `${name} 已保存`
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存技能失败'
  } finally {
    skillSaving.value = false
  }
}

function replaceSkill(next: Skill): void {
  const index = skills.value.findIndex((item) => item.id === next.id)
  if (index >= 0) skills.value[index] = next
  else skills.value.push(next)
}

async function toggleSkill(skill: Skill, enabled: boolean): Promise<void> {
  error.value = null
  skillTogglingId.value = skill.id
  try {
    const result = await skillApi.update(skill.id, { enabled })
    replaceSkill(result.skill)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '切换状态失败'
  } finally {
    skillTogglingId.value = null
  }
}

async function removeSkill(): Promise<void> {
  const target = pendingRemoveSkill.value
  if (!target) return
  removingSkill.value = true
  error.value = null
  try {
    await skillApi.remove(target.id)
    skills.value = skills.value.filter((item) => item.id !== target.id)
    if (skillEditingId.value === target.id) closeSkillForm()
    pendingRemoveSkill.value = null
    notice.value = '技能已删除'
  } catch (e) {
    error.value = e instanceof Error ? e.message : '删除失败'
  } finally {
    removingSkill.value = false
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
      id="mcp"
      title="MCP 服务器"
      description="接入远程 MCP（Streamable HTTP，兼容旧 SSE）。单聊时 AI 可以调用这些服务器提供的工具；凭据加密保存在服务端。"
      icon="memory"
    >
      <p v-if="loading" class="py-2 text-[12px] text-muted">读取中…</p>

      <template v-else>
        <p v-if="servers.length === 0 && !mcpFormOpen" class="py-2 text-[12px] text-muted">
          还没有接入 MCP 服务器。填一个端点地址就能让 AI 用上外部工具。
        </p>

        <div class="space-y-2.5">
          <div
            v-for="server in servers"
            :key="server.id"
            class="rounded-lg border border-line bg-surface-2 p-3"
          >
            <div class="flex items-start gap-2.5">
              <div class="min-w-0 flex-1">
                <p class="flex flex-wrap items-center gap-1.5 text-[13px] font-medium text-text-strong">
                  {{ server.name }}
                  <span
                    class="rounded px-1.5 text-[10px] font-normal"
                    :class="server.enabled ? 'bg-success/10 text-success' : 'bg-surface-3 text-muted'"
                  >
                    {{ server.enabled ? '已启用' : '已停用' }}
                  </span>
                </p>
                <p class="mt-1 truncate text-[11.5px] text-muted" :title="server.url">{{ server.url }}</p>
                <p
                  class="mt-1.5 truncate text-[10.5px]"
                  :class="server.lastTestOk === false ? 'text-danger' : 'text-muted'"
                  :title="lastTestText(server)"
                >
                  {{ lastTestText(server) }}
                </p>
              </div>
              <Switch
                :model-value="server.enabled"
                :disabled="mcpTogglingId === server.id"
                size="sm"
                :aria-label="`启用 ${server.name}`"
                @update:model-value="(value) => toggleServer(server, value)"
              />
            </div>

            <div class="mt-2.5 flex flex-wrap items-center gap-1.5">
              <Button size="sm" variant="secondary" icon="edit" @click="openMcpForm(server)">编辑</Button>
              <Button
                size="sm"
                variant="ghost"
                icon="refresh"
                :loading="mcpTestingId === server.id"
                @click="testServer(server)"
              >
                测试
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon="trash"
                class="ml-auto hover:!bg-danger/10 hover:!text-danger"
                aria-label="删除 MCP 服务器"
                @click="pendingRemoveServer = server"
              />
            </div>
          </div>
        </div>

        <div
          v-if="mcpFormOpen"
          class="mt-3 space-y-3 rounded-lg border border-line bg-surface-2 p-3"
        >
          <div class="flex items-center justify-between gap-2">
            <p class="text-[12.5px] font-medium text-text-strong">
              {{ mcpEditing() ? '编辑 MCP 服务器' : '接入 MCP 服务器' }}
            </p>
            <Button size="sm" variant="ghost" icon="close" @click="closeMcpForm">收起</Button>
          </div>

          <Field label="名称" for-id="mcp-name" hint="工具会以 mcp_名称_工具名 的形式提供给 AI">
            <TextInput id="mcp-name" v-model="mcpForm.name" placeholder="例如：网页搜索" />
          </Field>
          <Field label="端点地址" for-id="mcp-url" hint="Streamable HTTP 端点；旧版 SSE 服务器也兼容">
            <TextInput
              id="mcp-url"
              v-model="mcpForm.url"
              placeholder="https://example.com/mcp"
              spellcheck="false"
            />
          </Field>

          <div class="space-y-2">
            <div class="flex items-center justify-between gap-2">
              <p class="text-[12px] text-text">
                自定义请求头
                <span v-if="mcpEditing() && savedHeadersText(mcpEditing()!)" class="text-muted">
                  （已保存：{{ savedHeadersText(mcpEditing()!) }}，留空表示不修改）
                </span>
              </p>
              <Button size="sm" variant="ghost" icon="plus" @click="addHeaderRow">加一项</Button>
            </div>
            <div v-for="(row, index) in mcpForm.headers" :key="index" class="flex items-center gap-2">
              <TextInput v-model="row.key" placeholder="Header 名，如 Authorization" spellcheck="false" />
              <TextInput
                v-model="row.value"
                type="password"
                placeholder="值（加密保存）"
                autocomplete="off"
                spellcheck="false"
              />
              <Button
                size="sm"
                variant="ghost"
                icon="trash"
                :aria-label="`删除第 ${index + 1} 个请求头`"
                @click="removeHeaderRow(index)"
              />
            </div>
          </div>

          <Field label="工具调用超时" for-id="mcp-timeout" optional hint="毫秒，1000-120000；留空用默认 30000">
            <NumberInput id="mcp-timeout" v-model="mcpForm.timeoutMs" :min="1000" :max="120000" suffix="ms" />
          </Field>

          <div class="flex items-center justify-end gap-2 border-t border-line pt-3">
            <Button size="sm" variant="ghost" @click="closeMcpForm">取消</Button>
            <Button size="sm" variant="primary" :loading="mcpSaving" @click="saveMcp">保存服务器</Button>
          </div>
        </div>
        <div v-else class="mt-3">
          <Button size="sm" variant="secondary" icon="plus" @click="openMcpForm(null)">接入 MCP 服务器</Button>
        </div>
      </template>
    </SettingsCard>

    <SettingsCard
      id="skills"
      title="技能"
      description="技能是可复用的提示词包。启用后目录注入系统提示词，AI 判断相关时用 read_skill 工具读取全文再照做。"
      icon="sparkles"
    >
      <p v-if="loading" class="py-2 text-[12px] text-muted">读取中…</p>

      <template v-else>
        <p v-if="skills.length === 0 && !skillFormOpen" class="py-2 text-[12px] text-muted">
          还没有技能。把常用玩法（比如「用表格整理日程」）写成 Markdown，AI 需要时会自己取。
        </p>

        <div class="space-y-2.5">
          <div
            v-for="skill in skills"
            :key="skill.id"
            class="rounded-lg border border-line bg-surface-2 p-3"
          >
            <div class="flex items-start gap-2.5">
              <div class="min-w-0 flex-1">
                <p class="flex flex-wrap items-center gap-1.5 text-[13px] font-medium text-text-strong">
                  {{ skill.name }}
                  <span
                    class="rounded px-1.5 text-[10px] font-normal"
                    :class="skill.enabled ? 'bg-success/10 text-success' : 'bg-surface-3 text-muted'"
                  >
                    {{ skill.enabled ? '已启用' : '已停用' }}
                  </span>
                </p>
                <p v-if="skill.description" class="mt-1 text-[11.5px] leading-relaxed text-muted">
                  {{ skill.description }}
                </p>
              </div>
              <Switch
                :model-value="skill.enabled"
                :disabled="skillTogglingId === skill.id"
                size="sm"
                :aria-label="`启用 ${skill.name}`"
                @update:model-value="(value) => toggleSkill(skill, value)"
              />
            </div>

            <div class="mt-2.5 flex items-center gap-1.5">
              <Button size="sm" variant="secondary" icon="edit" @click="openSkillForm(skill)">编辑</Button>
              <Button
                size="sm"
                variant="ghost"
                icon="trash"
                class="ml-auto hover:!bg-danger/10 hover:!text-danger"
                aria-label="删除技能"
                @click="pendingRemoveSkill = skill"
              />
            </div>
          </div>
        </div>

        <div
          v-if="skillFormOpen"
          class="mt-3 space-y-3 rounded-lg border border-line bg-surface-2 p-3"
        >
          <div class="flex items-center justify-between gap-2">
            <p class="text-[12.5px] font-medium text-text-strong">
              {{ skillEditing() ? '编辑技能' : '新建技能' }}
            </p>
            <Button size="sm" variant="ghost" icon="close" @click="closeSkillForm">收起</Button>
          </div>

          <Field label="名称" for-id="skill-name">
            <TextInput id="skill-name" v-model="skillForm.name" placeholder="例如：周报整理" />
          </Field>
          <Field label="一句话描述" for-id="skill-description" hint="模型靠这段话判断什么时候要用这个技能">
            <TextInput
              id="skill-description"
              v-model="skillForm.description"
              placeholder="把零散消息整理成周报格式"
            />
          </Field>
          <Field label="技能正文（Markdown）" for-id="skill-content" hint="AI 调用 read_skill 时读到的完整说明">
            <Textarea
              id="skill-content"
              v-model="skillForm.content"
              :rows="8"
              mono
              placeholder="## 步骤&#10;1. 先……&#10;2. 再……"
            />
          </Field>
          <label class="flex items-center justify-between gap-3 text-[12px] text-text">
            启用后进入技能目录
            <Switch v-model="skillForm.enabled" size="sm" />
          </label>

          <div class="flex items-center justify-end gap-2 border-t border-line pt-3">
            <Button size="sm" variant="ghost" @click="closeSkillForm">取消</Button>
            <Button size="sm" variant="primary" :loading="skillSaving" @click="saveSkill">保存技能</Button>
          </div>
        </div>
        <div v-else class="mt-3">
          <Button size="sm" variant="secondary" icon="plus" @click="openSkillForm(null)">新建技能</Button>
        </div>
      </template>
    </SettingsCard>

    <ConfirmDialog
      :open="Boolean(pendingRemoveServer)"
      title="删除这个 MCP 服务器？"
      :description="`「${pendingRemoveServer?.name ?? ''}」的加密请求头会被一并清除，AI 不再能调用它的工具。`"
      confirm-text="删除服务器"
      :loading="removingServer"
      @update:open="(value) => !value && (pendingRemoveServer = null)"
      @confirm="removeServer"
    />
    <ConfirmDialog
      :open="Boolean(pendingRemoveSkill)"
      title="删除这个技能？"
      :description="`「${pendingRemoveSkill?.name ?? ''}」会从技能目录移除。`"
      confirm-text="删除技能"
      :loading="removingSkill"
      @update:open="(value) => !value && (pendingRemoveSkill = null)"
      @confirm="removeSkill"
    />
  </div>
</template>
