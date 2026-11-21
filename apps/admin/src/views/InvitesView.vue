<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { adminApi, type AdminInvite } from '@/api/admin'
import EmptyState from '@/components/EmptyState.vue'
import Button from '@/components/ui/form/Button.vue'
import TextInput from '@/components/ui/form/TextInput.vue'
import Dialog from '@/components/ui/form/Dialog.vue'
import ConfirmDialog from '@/components/ui/form/ConfirmDialog.vue'
import Alert from '@/components/ui/form/Alert.vue'
import Icon from '@/components/ui/Icon.vue'
import { formatTime } from '@/utils/format'

const invites = ref<AdminInvite[]>([])
const loading = ref(true)
const errorMessage = ref('')
const notice = ref('')

/* 创建弹窗 */
const createOpen = ref(false)
const maxUses = ref('10')
const expiresInDays = ref('7')
const creating = ref(false)

/* 删除确认 */
const deleteTarget = ref<AdminInvite | null>(null)
const deleting = ref(false)

async function load(): Promise<void> {
  loading.value = true
  try {
    const res = await adminApi.invites.list()
    invites.value = res.invites
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : '加载失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)

async function create(): Promise<void> {
  const uses = Number.parseInt(maxUses.value, 10)
  const days = Number.parseInt(expiresInDays.value, 10)
  if (!Number.isFinite(uses) || uses < 1) {
    errorMessage.value = '可使用次数至少为 1'
    return
  }
  creating.value = true
  errorMessage.value = ''
  try {
    const res = await adminApi.invites.create({
      maxUses: uses,
      expiresInDays: Number.isFinite(days) && days > 0 ? days : null,
    })
    createOpen.value = false
    notice.value = `邀请码已创建：${res.invite.code}（复制发给受邀人）`
    await load()
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : '创建失败'
  } finally {
    creating.value = false
  }
}

async function remove(): Promise<void> {
  if (!deleteTarget.value) return
  deleting.value = true
  try {
    await adminApi.invites.remove(deleteTarget.value.code)
    deleteTarget.value = null
    notice.value = ''
    await load()
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : '删除失败'
  } finally {
    deleting.value = false
  }
}

function inviteState(invite: AdminInvite): { label: string; tone: 'success' | 'muted' | 'danger' } {
  if (invite.expiresAt !== null && invite.expiresAt < Date.now())
    return { label: '已过期', tone: 'danger' }
  if (invite.uses >= invite.maxUses) return { label: '已用尽', tone: 'danger' }
  return { label: '可用', tone: 'success' }
}

async function copyCode(invite: AdminInvite): Promise<void> {
  try {
    await navigator.clipboard.writeText(invite.code)
    notice.value = `已复制邀请码：${invite.code}`
  } catch {
    notice.value = ''
  }
}
</script>

<template>
  <div>
    <div class="mb-4 flex items-center justify-between">
      <h1 class="text-[19px] font-semibold text-text-strong">邀请码</h1>
      <Button variant="primary" size="sm" icon="plus" @click="createOpen = true">新建邀请码</Button>
    </div>

    <Alert v-if="notice" tone="success" class="mb-3">
      {{ notice }}
      <button class="ml-1 underline" @click="notice = ''">知道了</button>
    </Alert>
    <div v-if="errorMessage" class="mb-3 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
      {{ errorMessage }}
    </div>

    <div class="overflow-hidden rounded-xl border border-line bg-surface">
      <div v-if="loading" class="p-4">
        <div v-for="i in 3" :key="i" class="mb-2 h-10 animate-pulse rounded-lg bg-surface-2" />
      </div>
      <EmptyState v-else-if="invites.length === 0" text="还没有邀请码。注册模式为「凭邀请码」时，新用户需要持码注册" />
      <table v-else class="w-full text-left text-[12.5px]">
        <thead>
          <tr class="border-b border-line text-[11.5px] text-muted">
            <th class="px-4 py-2 font-medium">邀请码</th>
            <th class="px-4 py-2 font-medium">状态</th>
            <th class="px-4 py-2 font-medium">已用 / 上限</th>
            <th class="px-4 py-2 font-medium">过期时间</th>
            <th class="px-4 py-2 font-medium">创建者</th>
            <th class="px-4 py-2 text-right font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="invite in invites" :key="invite.code" class="border-b border-line/60 last:border-b-0">
            <td class="px-4 py-2.5">
              <span class="font-mono text-[12.5px] text-text-strong">{{ invite.code }}</span>
              <button
                class="ml-2 text-muted transition-colors hover:text-text"
                aria-label="复制邀请码"
                @click="copyCode(invite)"
              >
                <Icon name="copy" :size="13" />
              </button>
            </td>
            <td class="px-4 py-2.5">
              <span
                class="rounded-full px-2 py-0.5 text-[11px] font-medium"
                :class="{
                  'bg-success/10 text-success': inviteState(invite).tone === 'success',
                  'bg-danger/10 text-danger': inviteState(invite).tone === 'danger',
                  'bg-surface-3 text-muted': inviteState(invite).tone === 'muted',
                }"
              >
                {{ inviteState(invite).label }}
              </span>
            </td>
            <td class="px-4 py-2.5 text-muted tabular-nums">{{ invite.uses }} / {{ invite.maxUses }}</td>
            <td class="px-4 py-2.5 text-muted">{{ invite.expiresAt === null ? '不过期' : formatTime(invite.expiresAt) }}</td>
            <td class="px-4 py-2.5 text-muted">{{ invite.createdByName ?? '—' }}</td>
            <td class="px-4 py-2.5 text-right">
              <Button size="sm" variant="danger-ghost" @click="deleteTarget = invite">删除</Button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <Dialog
      v-model:open="createOpen"
      title="新建邀请码"
      description="邀请码在注册模式为「凭邀请码」时使用，注册成功后自动消耗一次。"
      width="sm"
    >
      <div class="space-y-3 py-1">
        <div>
          <label class="mb-1 block text-[12px] text-muted" for="invite-uses">可使用次数</label>
          <TextInput id="invite-uses" v-model="maxUses" type="text" placeholder="10" />
        </div>
        <div>
          <label class="mb-1 block text-[12px] text-muted" for="invite-days">有效天数（留空或 0 表示不过期）</label>
          <TextInput id="invite-days" v-model="expiresInDays" type="text" placeholder="7" />
        </div>
      </div>
      <template #footer>
        <Button variant="ghost" @click="createOpen = false">取消</Button>
        <Button variant="primary" :loading="creating" @click="create">创建</Button>
      </template>
    </Dialog>

    <ConfirmDialog
      :open="deleteTarget !== null"
      title="删除邀请码？"
      :description="`删除后持有该码的人将无法再用它注册。已消耗的次数不受影响。`"
      confirm-text="删除"
      tone="danger"
      :loading="deleting"
      @update:open="(v: boolean) => { if (!v) deleteTarget = null }"
      @confirm="remove"
    />
  </div>
</template>
