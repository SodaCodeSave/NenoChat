<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { adminApi, type AdminComment, type AdminPost } from '@/api/admin'
import Pagination from '@/components/Pagination.vue'
import EmptyState from '@/components/EmptyState.vue'
import Button from '@/components/ui/form/Button.vue'
import TextInput from '@/components/ui/form/TextInput.vue'
import Dialog from '@/components/ui/form/Dialog.vue'
import ConfirmDialog from '@/components/ui/form/ConfirmDialog.vue'
import Icon from '@/components/ui/Icon.vue'
import { formatTime } from '@/utils/format'

const PAGE_SIZE = 20

const items = ref<AdminPost[]>([])
const total = ref(0)
const page = ref(1)
const query = ref('')
const loading = ref(true)
const errorMessage = ref('')

const deletePost = ref<AdminPost | null>(null)
const deleting = ref(false)

/* 评论区浏览 */
const commentsFor = ref<AdminPost | null>(null)
const comments = ref<AdminComment[]>([])
const commentsLoading = ref(false)
const deleteComment = ref<AdminComment | null>(null)

async function load(): Promise<void> {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = await adminApi.posts.list({ q: query.value.trim() || undefined, page: page.value })
    items.value = res.items
    total.value = res.total
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : '加载失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(query, () => {
  page.value = 1
  void load()
})
watch(page, load)

async function confirmDeletePost(): Promise<void> {
  if (!deletePost.value) return
  deleting.value = true
  try {
    await adminApi.posts.remove(deletePost.value.id)
    deletePost.value = null
    await load()
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : '删除失败'
  } finally {
    deleting.value = false
  }
}

async function openComments(post: AdminPost): Promise<void> {
  commentsFor.value = post
  comments.value = []
  commentsLoading.value = true
  try {
    const res = await adminApi.posts.comments(post.id)
    comments.value = res.comments.filter((c) => !c.deletedAt)
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : '加载评论失败'
  } finally {
    commentsLoading.value = false
  }
}

async function confirmDeleteComment(): Promise<void> {
  if (!deleteComment.value) return
  deleting.value = true
  try {
    await adminApi.posts.removeComment(deleteComment.value.id)
    comments.value = comments.value.filter((c) => c.id !== deleteComment.value?.id)
    deleteComment.value = null
    await load()
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : '删除失败'
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div>
    <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-[19px] font-semibold text-text-strong">动态</h1>
      <TextInput v-model="query" type="search" placeholder="搜索动态内容" icon="search" size="sm" class="w-56" />
    </div>

    <div v-if="errorMessage" class="mb-3 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
      {{ errorMessage }}
    </div>

    <div class="overflow-hidden rounded-xl border border-line bg-surface">
      <div v-if="loading && items.length === 0" class="p-4">
        <div v-for="i in 4" :key="i" class="mb-2 h-14 animate-pulse rounded-lg bg-surface-2" />
      </div>
      <EmptyState v-else-if="items.length === 0" text="没有匹配的动态" />
      <ul v-else class="divide-y divide-line/60">
        <li v-for="p in items" :key="p.id" class="px-4 py-3">
          <div class="flex items-center gap-2 text-[12px] text-muted">
            <span class="font-medium text-text">{{ p.authorName ?? '未知用户' }}</span>
            <span v-if="p.personaId" class="rounded-full bg-accent-soft px-1.5 py-0.5 text-[10.5px] text-accent">
              AI 署名
            </span>
            <span>{{ formatTime(p.createdAt) }}</span>
            <span class="flex items-center gap-1"><Icon name="heart" :size="12" /> {{ p.likeCount }}</span>
            <span class="flex items-center gap-1"><Icon name="comment" :size="12" /> {{ p.commentCount }}</span>
          </div>
          <p class="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-[12.5px] text-text-strong">
            {{ p.content }}
          </p>
          <div class="mt-2 flex items-center gap-1.5">
            <Button size="sm" variant="ghost" @click="openComments(p)">查看评论</Button>
            <Button size="sm" variant="danger-ghost" @click="deletePost = p">删除动态</Button>
          </div>
        </li>
      </ul>
      <div class="border-t border-line px-4 py-2.5">
        <Pagination v-model:page="page" :total="total" :page-size="PAGE_SIZE" />
      </div>
    </div>

    <ConfirmDialog
      :open="deletePost !== null"
      title="删除这条动态？"
      description="删除后所有用户的动态流里都会消失，操作会记入审计日志。"
      confirm-text="删除"
      tone="danger"
      :loading="deleting"
      @update:open="(v: boolean) => { if (!v) deletePost = null }"
      @confirm="confirmDeletePost"
    />

    <!-- 评论区 -->
    <Dialog
      :open="commentsFor !== null"
      title="评论区"
      :description="`动态作者：${commentsFor?.authorName ?? '未知用户'}，共 ${comments.length} 条未删除评论`"
      width="md"
      @update:open="(v: boolean) => { if (!v) commentsFor = null }"
    >
      <div class="py-1">
        <div v-if="commentsLoading" class="space-y-2">
          <div v-for="i in 3" :key="i" class="h-10 animate-pulse rounded-lg bg-surface-2" />
        </div>
        <EmptyState v-else-if="comments.length === 0" text="没有评论" />
        <ul v-else class="divide-y divide-line/60">
          <li v-for="c in comments" :key="c.id" class="flex items-start justify-between gap-3 py-2.5">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 text-[11.5px] text-muted">
                <span class="font-medium text-text">
                  {{ c.author?.displayName ?? (c.personaId ? 'AI 角色' : '未知用户') }}
                </span>
                <span>{{ formatTime(c.createdAt) }}</span>
              </div>
              <p class="mt-0.5 break-words text-[12.5px] text-text">{{ c.content }}</p>
            </div>
            <Button size="sm" variant="danger-ghost" @click="deleteComment = c">删除</Button>
          </li>
        </ul>
      </div>
    </Dialog>

    <ConfirmDialog
      :open="deleteComment !== null"
      title="删除这条评论？"
      :description="`「${deleteComment?.content.slice(0, 40) ?? ''}」将被删除，动态的评论数会同步扣减。`"
      confirm-text="删除"
      tone="danger"
      :loading="deleting"
      @update:open="(v: boolean) => { if (!v) deleteComment = null }"
      @confirm="confirmDeleteComment"
    />
  </div>
</template>
