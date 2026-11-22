<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { adminApi, type AdminConversation, type AdminMessage } from '@/api/admin'
import Pagination from '@/components/Pagination.vue'
import EmptyState from '@/components/EmptyState.vue'
import Button from '@/components/ui/form/Button.vue'
import TextInput from '@/components/ui/form/TextInput.vue'
import Segmented from '@/components/ui/form/Segmented.vue'
import Dialog from '@/components/ui/form/Dialog.vue'
import ConfirmDialog from '@/components/ui/form/ConfirmDialog.vue'
import { formatTime } from '@/utils/format'

const PAGE_SIZE = 20

const items = ref<AdminConversation[]>([])
const total = ref(0)
const page = ref(1)
const query = ref('')
const typeFilter = ref<string>('')
const loading = ref(true)
const errorMessage = ref('')

/* 消息查看弹窗 */
const viewing = ref<AdminConversation | null>(null)
const messages = ref<AdminMessage[]>([])
const messagesLoading = ref(false)
const loadingMore = ref(false)

/* 撤回确认 */
const recallTarget = ref<AdminMessage | null>(null)
const recallLoading = ref(false)

async function load(): Promise<void> {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = await adminApi.conversations.list({
      type: typeFilter.value || undefined,
      q: query.value.trim() || undefined,
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
watch([query, typeFilter], () => {
  page.value = 1
  void load()
})
watch(page, load)

function typeLabel(type: string): string {
  return type === 'direct' ? '私聊' : type === 'group' ? '群聊' : 'AI'
}

function convTitle(conv: AdminConversation): string {
  return conv.name ?? (conv.type === 'direct' ? '私聊' : conv.type === 'ai' ? 'AI 会话' : '未命名群聊')
}

async function openMessages(conv: AdminConversation): Promise<void> {
  viewing.value = conv
  messages.value = []
  messagesLoading.value = true
  try {
    const res = await adminApi.conversations.messages(conv.id)
    messages.value = res.items
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : '加载消息失败'
  } finally {
    messagesLoading.value = false
  }
}

async function loadMore(): Promise<void> {
  if (!viewing.value || messages.value.length === 0) return
  loadingMore.value = true
  try {
    const beforeSeq = messages.value[messages.value.length - 1]?.seq
    const res = await adminApi.conversations.messages(viewing.value.id, beforeSeq)
    messages.value.push(...res.items)
  } finally {
    loadingMore.value = false
  }
}

async function confirmRecall(): Promise<void> {
  if (!recallTarget.value) return
  recallLoading.value = true
  try {
    await adminApi.conversations.recallMessage(recallTarget.value.id)
    messages.value = messages.value.filter((m) => m.id !== recallTarget.value?.id)
    recallTarget.value = null
    await load()
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : '撤回失败'
  } finally {
    recallLoading.value = false
  }
}
</script>

<template>
  <div>
    <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-[19px] font-semibold text-text-strong">会话与消息</h1>
      <div class="flex items-center gap-2">
        <TextInput v-model="query" type="search" placeholder="搜索群聊名称" icon="search" size="sm" class="w-52" />
        <Segmented
          v-model="typeFilter"
          size="sm"
          aria-label="类型过滤"
          :options="[
            { value: '', label: '全部' },
            { value: 'direct', label: '私聊' },
            { value: 'group', label: '群聊' },
            { value: 'ai', label: 'AI' },
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
      <EmptyState v-else-if="items.length === 0" text="没有匹配的会话" />
      <table v-else class="w-full text-left text-[12.5px]">
        <thead>
          <tr class="border-b border-line text-[11.5px] text-muted">
            <th class="px-4 py-2 font-medium">会话</th>
            <th class="px-4 py-2 font-medium">类型</th>
            <th class="px-4 py-2 font-medium">成员</th>
            <th class="px-4 py-2 font-medium">消息数</th>
            <th class="px-4 py-2 font-medium">最近活跃</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="c in items"
            :key="c.id"
            class="cursor-pointer border-b border-line/60 transition-colors last:border-b-0 hover:bg-surface-2"
            @click="openMessages(c)"
          >
            <td class="px-4 py-2.5 font-medium text-text-strong">{{ convTitle(c) }}</td>
            <td class="px-4 py-2.5">
              <span class="rounded-full bg-surface-3 px-2 py-0.5 text-[11px] text-muted">{{ typeLabel(c.type) }}</span>
            </td>
            <td class="px-4 py-2.5 text-muted tabular-nums">{{ c.memberCount }}</td>
            <td class="px-4 py-2.5 text-muted tabular-nums">{{ c.messageCount }}</td>
            <td class="px-4 py-2.5 text-muted">{{ formatTime(c.lastActivityAt) }}</td>
          </tr>
        </tbody>
      </table>
      <div class="border-t border-line px-4 py-2.5">
        <Pagination v-model:page="page" :total="total" :page-size="PAGE_SIZE" />
      </div>
    </div>

    <!-- 消息查看 -->
    <Dialog
      :open="viewing !== null"
      :title="`消息浏览 — ${viewing ? convTitle(viewing) : ''}`"
      description="按时间倒序，只显示未删除的消息；为保护隐私，消息内容已隐藏，仅显示发送者与时间"
      width="lg"
      @update:open="(v: boolean) => { if (!v) viewing = null }"
    >
      <div class="py-1">
        <div v-if="messagesLoading" class="space-y-2">
          <div v-for="i in 5" :key="i" class="h-12 animate-pulse rounded-lg bg-surface-2" />
        </div>
        <EmptyState v-else-if="messages.length === 0" text="这个会话还没有消息" />
        <div v-else class="divide-y divide-line/60">
          <div v-for="m in messages" :key="m.id" class="flex items-start justify-between gap-3 py-2.5">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 text-[11.5px] text-muted">
                <span class="font-medium text-text">{{ m.senderName ?? (m.senderType === 'system' ? '系统' : m.senderType === 'ai' ? 'AI' : '未知用户') }}</span>
                <span>seq {{ m.seq }}</span>
                <span>{{ formatTime(m.createdAt) }}</span>
              </div>
              <div class="mt-0.5 break-words text-[12.5px] text-text">
                {{ m.type === 'text' ? m.content : `[${m.type}] ${m.content}`.trim() }}
              </div>
            </div>
            <Button v-if="m.senderType === 'user'" size="sm" variant="danger-ghost" @click="recallTarget = m">
              撤回
            </Button>
          </div>
        </div>
        <div v-if="messages.length >= PAGE_SIZE" class="mt-3 text-center">
          <Button size="sm" variant="ghost" :loading="loadingMore" @click="loadMore">加载更早的消息</Button>
        </div>
      </div>
    </Dialog>

    <ConfirmDialog
      :open="recallTarget !== null"
      title="撤回这条消息？"
      description="消息将从所有成员的会话中消失，操作会记入审计日志。"
      confirm-text="撤回"
      tone="danger"
      :loading="recallLoading"
      @update:open="(v: boolean) => { if (!v) recallTarget = null }"
      @confirm="confirmRecall"
    />
  </div>
</template>
