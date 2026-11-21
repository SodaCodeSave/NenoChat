<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { adminApi, type AdminUserDetail, type AdminUserListItem } from '@/api/admin'
import Pagination from '@/components/Pagination.vue'
import StatusBadge from '@/components/StatusBadge.vue'
import EmptyState from '@/components/EmptyState.vue'
import Button from '@/components/ui/form/Button.vue'
import TextInput from '@/components/ui/form/TextInput.vue'
import Segmented from '@/components/ui/form/Segmented.vue'
import ConfirmDialog from '@/components/ui/form/ConfirmDialog.vue'
import Dialog from '@/components/ui/form/Dialog.vue'
import Icon from '@/components/ui/Icon.vue'
import { formatNumber, formatRelative } from '@/utils/format'

const PAGE_SIZE = 20

const items = ref<AdminUserListItem[]>([])
const total = ref(0)
const page = ref(1)
const query = ref('')
const statusFilter = ref<string>('')
const loading = ref(true)
const errorMessage = ref('')

/* 操作确认弹窗状态 */
type PendingAction = 'disable' | 'enable' | 'delete' | 'set-admin' | 'unset-admin'
const pending = ref<{ action: PendingAction; user: AdminUserListItem } | null>(null)
const confirmLoading = ref(false)

/* 详情抽屉 */
const detail = ref<AdminUserDetail | null>(null)
const detailLoading = ref(false)

/* 重置密码弹窗 */
const resetTarget = ref<AdminUserListItem | null>(null)
const newPassword = ref('')
const resetLoading = ref(false)
const resetError = ref('')

async function load(): Promise<void> {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = await adminApi.users.list({
      q: query.value.trim() || undefined,
      status: statusFilter.value || undefined,
      page: page.value,
    })
    items.value = res.items
    total.value = res.total
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : '加载失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch([query, statusFilter], () => {
  page.value = 1
  void load()
})
watch(page, load)

function confirmTitle(): string {
  if (!pending.value) return ''
  const { action, user } = pending.value
  if (action === 'disable') return `停用「${user.displayName}」？`
  if (action === 'enable') return `启用「${user.displayName}」？`
  if (action === 'delete') return `删除「${user.displayName}」？`
  if (action === 'set-admin') return `授予「${user.displayName}」管理员权限？`
  return `撤销「${user.displayName}」的管理员权限？`
}

function confirmDescription(): string {
  if (!pending.value) return ''
  const { action, user } = pending.value
  if (action === 'disable')
    return '该账号将立即无法登录，所有会话令牌会被吊销；动态、消息等数据保留。'
  if (action === 'enable') return '账号恢复正常，可重新登录。'
  if (action === 'delete')
    return '不可恢复：TA 发送的在屏消息会被撤回、动态与评论被删除、所在群主移交其他成员。该操作会记入审计日志。'
  if (action === 'set-admin') return '管理员可以管理所有用户、删除任意内容与修改服务器设置。'
  return '撤销后该账号将无法访问管理面板。'
}

async function runPending(): Promise<void> {
  if (!pending.value) return
  const { action, user } = pending.value
  confirmLoading.value = true
  try {
    if (action === 'disable') await adminApi.users.disable(user.id)
    else if (action === 'enable') await adminApi.users.enable(user.id)
    else if (action === 'delete') await adminApi.users.delete(user.id)
    else if (action === 'set-admin') await adminApi.users.setAdmin(user.id, true)
    else if (action === 'unset-admin') await adminApi.users.setAdmin(user.id, false)
    pending.value = null
    await load()
    if (detail.value && detail.value.user.id === user.id) {
      if (action !== 'delete') detail.value = await adminApi.users.detail(user.id)
      else detail.value = null
    }
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : '操作失败'
  } finally {
    confirmLoading.value = false
  }
}

async function openDetail(user: AdminUserListItem): Promise<void> {
  detailLoading.value = true
  detail.value = null
  try {
    detail.value = await adminApi.users.detail(user.id)
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : '加载详情失败'
  } finally {
    detailLoading.value = false
  }
}

async function openReset(user: AdminUserListItem): Promise<void> {
  resetTarget.value = user
  newPassword.value = ''
  resetError.value = ''
}

async function runReset(): Promise<void> {
  const target = resetTarget.value
  if (!target || newPassword.value.length < 6) {
    resetError.value = '密码至少 6 位'
    return
  }
  resetLoading.value = true
  resetError.value = ''
  try {
    await adminApi.users.resetPassword(target.id, newPassword.value)
    resetTarget.value = null
    if (detail.value?.user.id === target.id) {
      detail.value = await adminApi.users.detail(target.id)
    }
  } catch (e) {
    resetError.value = e instanceof Error ? e.message : '重置失败'
  } finally {
    resetLoading.value = false
  }
}
</script>

<template>
  <div>
    <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-[19px] font-semibold text-text-strong">用户</h1>
      <div class="flex items-center gap-2">
        <TextInput v-model="query" type="search" placeholder="搜索用户名或昵称" icon="search" size="sm" class="w-56" />
        <Segmented
          v-model="statusFilter"
          size="sm"
          aria-label="状态过滤"
          :options="[
            { value: '', label: '全部' },
            { value: 'active', label: '正常' },
            { value: 'disabled', label: '停用' },
          ]"
        />
      </div>
    </div>

    <div v-if="errorMessage" class="mb-3 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
      {{ errorMessage }}
    </div>

    <div class="overflow-hidden rounded-xl border border-line bg-surface">
      <div v-if="loading && items.length === 0" class="p-4">
        <div v-for="i in 5" :key="i" class="mb-2 h-10 animate-pulse rounded-lg bg-surface-2" />
      </div>
      <EmptyState v-else-if="items.length === 0" text="没有匹配的用户" />
      <table v-else class="w-full text-left text-[12.5px]">
        <thead>
          <tr class="border-b border-line text-[11.5px] text-muted">
            <th class="px-4 py-2 font-medium">用户</th>
            <th class="px-4 py-2 font-medium">状态</th>
            <th class="px-4 py-2 font-medium">设备</th>
            <th class="px-4 py-2 font-medium">注册</th>
            <th class="px-4 py-2 font-medium">最近活跃</th>
            <th class="px-4 py-2 text-right font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="u in items"
            :key="u.id"
            class="cursor-pointer border-b border-line/60 transition-colors last:border-b-0 hover:bg-surface-2"
            @click="openDetail(u)"
          >
            <td class="px-4 py-2.5">
              <div class="flex items-center gap-2">
                <span class="font-medium text-text-strong">{{ u.displayName }}</span>
                <span class="text-[11.5px] text-muted">@{{ u.username }}</span>
                <span
                  v-if="u.isAdmin"
                  class="inline-flex items-center gap-0.5 rounded-full bg-accent-soft px-1.5 py-0.5 text-[10.5px] font-medium text-accent"
                >
                  <Icon name="shield" :size="10" />
                  管理员
                </span>
              </div>
            </td>
            <td class="px-4 py-2.5"><StatusBadge :status="u.status" /></td>
            <td class="px-4 py-2.5 text-muted tabular-nums">{{ u.deviceCount }}</td>
            <td class="px-4 py-2.5 text-muted">{{ formatRelative(u.createdAt) }}</td>
            <td class="px-4 py-2.5 text-muted">{{ formatRelative(u.lastSeenAt) }}</td>
            <td class="px-4 py-2.5">
              <div class="flex items-center justify-end gap-1" @click.stop>
                <Button v-if="u.status === 'active'" size="sm" variant="ghost" @click="pending = { action: 'disable', user: u }">
                  停用
                </Button>
                <Button v-else size="sm" variant="ghost" @click="pending = { action: 'enable', user: u }">
                  启用
                </Button>
                <Button size="sm" variant="ghost" @click="openReset(u)">重置密码</Button>
                <Button
                  v-if="!u.isAdmin"
                  size="sm"
                  variant="ghost"
                  @click="pending = { action: 'set-admin', user: u }"
                >
                  设为管理员
                </Button>
                <Button
                  v-else
                  size="sm"
                  variant="ghost"
                  @click="pending = { action: 'unset-admin', user: u }"
                >
                  撤销管理员
                </Button>
                <Button size="sm" variant="danger-ghost" @click="pending = { action: 'delete', user: u }">
                  删除
                </Button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="border-t border-line px-4 py-2.5">
        <Pagination v-model:page="page" :total="total" :page-size="PAGE_SIZE" />
      </div>
    </div>

    <ConfirmDialog
      :open="pending !== null"
      :title="confirmTitle()"
      :description="confirmDescription()"
      :confirm-text="pending?.action === 'delete' ? '永久删除' : '确认'"
      tone="danger"
      :loading="confirmLoading"
      @update:open="(v: boolean) => { if (!v) pending = null }"
      @confirm="runPending"
    />

    <ConfirmDialog
      :open="resetTarget !== null"
      title="重置密码"
      :description="`为「${resetTarget?.displayName ?? ''}」设置新密码。该用户的所有登录会话将被吊销，需要用新密码重新登录。`"
      confirm-text="重置"
      tone="danger"
      :loading="resetLoading"
      @update:open="(v: boolean) => { if (!v) resetTarget = null }"
      @confirm="runReset"
    >
      <div class="mt-1">
        <TextInput v-model="newPassword" type="password" placeholder="新密码（至少 6 位）" class="w-full" />
        <div v-if="resetError" class="mt-1.5 text-[11.5px] text-danger">{{ resetError }}</div>
      </div>
    </ConfirmDialog>

    <!-- 详情抽屉 -->
    <Dialog
      :open="detail !== null || detailLoading"
      :title="detail?.user.displayName ?? '用户详情'"
      :description="`@${detail?.user.username ?? ''}`"
      width="md"
      @update:open="(v: boolean) => { if (!v) detail = null }"
    >
      <div v-if="detailLoading" class="space-y-2 py-2">
        <div v-for="i in 4" :key="i" class="h-8 animate-pulse rounded-lg bg-surface-2" />
      </div>
      <div v-else-if="detail" class="space-y-4 py-1">
        <div class="grid grid-cols-4 gap-2 text-center">
          <div class="rounded-lg border border-line px-2 py-2">
            <div class="text-[16px] font-semibold text-text-strong tabular-nums">{{ formatNumber(detail.messageCount) }}</div>
            <div class="text-[10.5px] text-muted">消息</div>
          </div>
          <div class="rounded-lg border border-line px-2 py-2">
            <div class="text-[16px] font-semibold text-text-strong tabular-nums">{{ formatNumber(detail.postCount) }}</div>
            <div class="text-[10.5px] text-muted">动态</div>
          </div>
          <div class="rounded-lg border border-line px-2 py-2">
            <div class="text-[16px] font-semibold text-text-strong tabular-nums">{{ formatNumber(detail.conversationCount) }}</div>
            <div class="text-[10.5px] text-muted">会话</div>
          </div>
          <div class="rounded-lg border border-line px-2 py-2">
            <div class="text-[16px] font-semibold text-text-strong tabular-nums">{{ formatNumber(detail.sessionCount) }}</div>
            <div class="text-[10.5px] text-muted">活跃会话</div>
          </div>
        </div>

        <div>
          <div class="mb-1.5 text-[12px] font-medium text-text-strong">登录设备（{{ detail.devices.length }}）</div>
          <div v-if="detail.devices.length === 0" class="rounded-lg border border-line px-3 py-3 text-[12px] text-muted">
            没有登录设备
          </div>
          <div v-else class="divide-y divide-line overflow-hidden rounded-lg border border-line">
            <div v-for="d in detail.devices" :key="d.id" class="flex items-center justify-between px-3 py-2">
              <div class="min-w-0">
                <div class="truncate text-[12.5px] text-text">{{ d.name }}</div>
                <div class="text-[11px] text-muted">{{ d.platform }} · 最近活跃 {{ formatRelative(d.lastActiveAt) }}</div>
              </div>
              <Button
                size="sm"
                variant="danger-ghost"
                @click="
                  async () => {
                    if (detail) {
                      await adminApi.users.removeDevice(detail.user.id, d.id)
                      detail = await adminApi.users.detail(detail.user.id)
                    }
                  }
                "
              >
                移除
              </Button>
            </div>
          </div>
        </div>

        <div class="text-[11.5px] text-muted">
          注册于 {{ formatRelative(detail.user.createdAt) }} · 用户 ID
          <span class="font-mono">{{ detail.user.id }}</span>
        </div>
      </div>
    </Dialog>
  </div>
</template>
