<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { Post } from '@nenochat/shared'
import Avatar from '@/components/ui/Avatar.vue'
import Icon from '@/components/ui/Icon.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import { uploadFile } from '@/api/files'
import { resolveFileUrl } from '@/api/http'
import { useAuthStore } from '@/stores/auth'
import { useMomentsStore } from '@/stores/moments'
import { useUiStore } from '@/stores/ui'

const auth = useAuthStore()
const moments = useMomentsStore()
const ui = useUiStore()

const draft = ref('')
const pendingImages = ref<Array<{ id: string; url: string; name: string }>>([])
const uploading = ref(false)
const uploadError = ref<string | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const openComments = ref<Record<string, boolean>>({})
const commentDrafts = ref<Record<string, string>>({})

const canPublish = computed(
  () => (draft.value.trim().length > 0 || pendingImages.value.length > 0) && !moments.publishing,
)

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  const date = new Date(ts)
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

async function pickImages(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (files.length === 0) return

  uploading.value = true
  uploadError.value = null
  try {
    for (const file of files.slice(0, 9 - pendingImages.value.length)) {
      if (!file.type.startsWith('image/')) {
        uploadError.value = '动态只能配图片'
        continue
      }
      const attachment = await uploadFile(file, { kind: 'file' })
      pendingImages.value = [
        ...pendingImages.value,
        { id: attachment.id, url: attachment.url, name: attachment.filename },
      ]
    }
  } catch (e) {
    uploadError.value = e instanceof Error ? e.message : '图片上传失败'
  } finally {
    uploading.value = false
  }
}

function removePendingImage(id: string): void {
  pendingImages.value = pendingImages.value.filter((item) => item.id !== id)
}

async function publish(): Promise<void> {
  if (!canPublish.value) return
  try {
    await moments.publish(
      draft.value.trim(),
      pendingImages.value.map((item) => item.id),
    )
    draft.value = ''
    pendingImages.value = []
  } catch {
    /* 错误已写进 store.error */
  }
}

async function toggleComments(post: Post): Promise<void> {
  const next = !openComments.value[post.id]
  openComments.value = { ...openComments.value, [post.id]: next }
  if (next) await moments.loadComments(post.id)
}

async function submitComment(post: Post): Promise<void> {
  const content = (commentDrafts.value[post.id] ?? '').trim()
  if (!content) return
  commentDrafts.value = { ...commentDrafts.value, [post.id]: '' }
  try {
    await moments.addComment(post.id, content)
    openComments.value = { ...openComments.value, [post.id]: true }
  } catch {
    commentDrafts.value = { ...commentDrafts.value, [post.id]: content }
  }
}

async function removePost(post: Post): Promise<void> {
  if (!window.confirm('删除这条动态？')) return
  await moments.remove(post.id).catch(() => undefined)
}

async function removeComment(postId: string, commentId: string): Promise<void> {
  await moments.removeComment(postId, commentId).catch(() => undefined)
}

function isMine(post: Post): boolean {
  return post.authorId === auth.user?.id
}

onMounted(() => {
  void moments.load(true)
})
</script>

<template>
  <div class="flex h-full flex-col">
    <header
      class="flex shrink-0 items-center gap-2 border-b border-line px-4 pb-1"
      :class="
        ui.isMobile
          ? 'min-h-[calc(3rem+var(--safe-top))] pt-[var(--safe-top)]'
          : 'h-14'
      "
      data-tauri-drag-region
    >
      <h1 class="text-[16px] font-semibold text-text-strong">动态</h1>
      <p class="text-[11.5px] text-muted">全服可见</p>
      <button
        type="button"
        class="ml-auto rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-text active:bg-surface-3"
        title="刷新"
        @click="moments.load(true)"
      >
        <Icon name="refresh" :size="16" />
      </button>
    </header>

    <div class="scroll-area flex-1">
      <div class="mx-auto w-full max-w-2xl px-3 py-3 md:px-4 md:py-4">
        <!-- 发布框 -->
        <section class="rounded-2xl border border-line bg-surface p-3">
          <div class="flex gap-3">
            <Avatar
              :name="auth.user?.displayName ?? '我'"
              :src="auth.user?.avatarUrl ?? null"
              :seed="auth.user?.id ?? 'me'"
              :size="38"
            />
            <textarea
              v-model="draft"
              rows="3"
              maxlength="5000"
              placeholder="分享点什么…"
              class="min-h-[72px] w-full resize-none rounded-xl border border-line bg-surface-2 px-3 py-2 text-[13.5px] leading-[1.6] outline-none focus:border-accent"
            />
          </div>

          <div v-if="pendingImages.length > 0" class="mt-2 grid grid-cols-3 gap-2 pl-[50px]">
            <div
              v-for="image in pendingImages"
              :key="image.id"
              class="group relative aspect-square overflow-hidden rounded-lg border border-line"
            >
              <img
                :src="resolveFileUrl(image.url) ?? ''"
                :alt="image.name"
                class="h-full w-full object-cover"
              />
              <button
                type="button"
                class="absolute top-1 right-1 rounded-full bg-black/60 p-1.5 text-white"
                :class="ui.isMobile ? 'block' : 'hidden group-hover:block'"
                @click="removePendingImage(image.id)"
              >
                <Icon name="close" :size="12" />
              </button>
            </div>
          </div>

          <div class="mt-2 flex items-center gap-2 pl-[50px]">
            <input
              ref="fileInput"
              type="file"
              accept="image/*"
              multiple
              class="hidden"
              @change="pickImages"
            />
            <button
              type="button"
              class="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-muted hover:bg-surface-2 hover:text-text disabled:opacity-50"
              :disabled="uploading || pendingImages.length >= 9"
              @click="fileInput?.click()"
            >
              <Icon name="image" :size="15" />
              {{ uploading ? '上传中…' : '图片' }}
            </button>
            <span class="text-[11px] text-muted">{{ pendingImages.length }}/9</span>
            <button
              type="button"
              class="ml-auto rounded-lg bg-accent px-3 py-1 text-[12.5px] font-medium text-accent-text disabled:opacity-50"
              :disabled="!canPublish"
              @click="publish"
            >
              {{ moments.publishing ? '发布中…' : '发布' }}
            </button>
          </div>

          <p v-if="uploadError" class="mt-1 pl-[50px] text-[11.5px] text-danger">{{ uploadError }}</p>
          <p v-if="moments.error" class="mt-1 pl-[50px] text-[11.5px] text-danger">{{ moments.error }}</p>
        </section>

        <!-- 信息流 -->
        <div
          v-if="moments.loading && moments.posts.length === 0"
          class="mt-3 space-y-3"
          aria-hidden="true"
        >
          <div
            v-for="index in 2"
            :key="index"
            class="rounded-2xl border border-line bg-surface p-3"
          >
            <div class="flex items-start gap-3">
              <Skeleton circle width="38px" height="38px" />
              <div class="min-w-0 flex-1 space-y-2 pt-0.5">
                <Skeleton width="38%" height="12px" />
                <Skeleton width="88%" height="12px" />
                <Skeleton width="64%" height="12px" />
                <Skeleton width="100%" height="104px" />
              </div>
            </div>
          </div>
        </div>

        <div v-else-if="moments.isEmpty" class="py-12 text-center">
          <Icon name="compass" :size="28" class="mx-auto mb-2 text-muted opacity-50" />
          <p class="text-[13px] text-text">还没有动态，发一条试试</p>
        </div>

        <section
          v-for="post in moments.posts"
          :key="post.id"
          class="mt-3 rounded-2xl border border-line bg-surface p-3"
        >
          <div class="flex items-start gap-3">
            <Avatar
              :name="post.author?.displayName ?? '用户'"
              :src="post.author?.avatarUrl ?? null"
              :seed="post.authorId"
              :size="38"
            />
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="text-[13.5px] font-medium text-text-strong">
                  {{ post.author?.displayName ?? '用户' }}
                </span>
                <span
                  v-if="post.personaId"
                  class="rounded bg-mention-soft px-1 py-0.5 text-[10px] font-medium text-mention"
                >
                  AI
                </span>
                <span class="text-[11px] text-muted">{{ relativeTime(post.createdAt) }}</span>
                <button
                  v-if="isMine(post)"
                  type="button"
                  class="ml-auto rounded p-1 text-muted hover:bg-danger/10 hover:text-danger"
                  title="删除"
                  @click="removePost(post)"
                >
                  <Icon name="trash" :size="14" />
                </button>
              </div>

              <p
                v-if="post.content"
                class="mt-1 text-[13.5px] leading-[1.65] whitespace-pre-wrap break-words text-text"
              >
                {{ post.content }}
              </p>

              <div
                v-if="post.attachments && post.attachments.length > 0"
                class="mt-2 grid gap-1.5"
                :class="post.attachments.length === 1 ? 'grid-cols-1' : 'grid-cols-3'"
              >
                <a
                  v-for="attachment in post.attachments"
                  :key="attachment.id"
                  :href="resolveFileUrl(attachment.url) ?? '#'"
                  target="_blank"
                  rel="noreferrer"
                  class="overflow-hidden rounded-lg border border-line"
                  :class="post.attachments.length === 1 ? 'max-h-[360px]' : 'aspect-square'"
                >
                  <img
                    :src="resolveFileUrl(attachment.thumbUrl || attachment.url) ?? ''"
                    :alt="attachment.filename"
                    class="h-full w-full object-cover"
                    loading="lazy"
                  />
                </a>
              </div>

              <div class="mt-2 flex items-center gap-1">
                <button
                  type="button"
                  class="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] transition-colors"
                  :class="post.likedByMe ? 'text-danger' : 'text-muted hover:text-text'"
                  @click="moments.toggleLike(post)"
                >
                  <Icon name="heart" :size="15" />
                  {{ post.likeCount > 0 ? post.likeCount : '赞' }}
                </button>
                <button
                  type="button"
                  class="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-muted hover:text-text"
                  @click="toggleComments(post)"
                >
                  <Icon name="comment" :size="15" />
                  {{ post.commentCount > 0 ? post.commentCount : '评论' }}
                </button>
              </div>

              <!-- 评论区 -->
              <div v-if="openComments[post.id]" class="mt-2 rounded-xl bg-surface-2 p-2">
                <div
                  v-for="comment in moments.comments[post.id] ?? []"
                  :key="comment.id"
                  class="group flex items-start gap-2 py-1"
                >
                  <Avatar
                    :name="comment.author?.displayName ?? '用户'"
                    :src="comment.author?.avatarUrl ?? null"
                    :seed="comment.authorId"
                    :size="24"
                  />
                  <p class="min-w-0 flex-1 text-[12.5px] leading-[1.55] break-words text-text">
                    <span class="mr-1 font-medium text-text-strong">
                      {{ comment.author?.displayName ?? '用户' }}
                    </span>
                    <span
                      v-if="comment.personaId"
                      class="mr-1 rounded bg-mention-soft px-1 text-[10px] text-mention"
                    >
                      AI
                    </span>
                    {{ comment.content }}
                  </p>
                  <button
                    v-if="comment.authorId === auth.user?.id || isMine(post)"
                    type="button"
                    class="p-1 text-muted hover:text-danger"
                    :class="ui.isMobile ? 'block' : 'hidden group-hover:block'"
                    title="删除评论"
                    @click="removeComment(post.id, comment.id)"
                  >
                    <Icon name="close" :size="12" />
                  </button>
                </div>

                <div class="mt-1 flex items-center gap-2">
                  <input
                    :value="commentDrafts[post.id] ?? ''"
                    placeholder="写评论…"
                    class="h-8 flex-1 rounded-lg border border-line bg-surface px-2 text-[12.5px] outline-none focus:border-accent"
                    @input="commentDrafts[post.id] = ($event.target as HTMLInputElement).value"
                    @keydown.enter.prevent="submitComment(post)"
                  />
                  <button
                    type="button"
                    class="rounded-lg bg-accent px-2.5 py-1 text-[12px] font-medium text-accent-text"
                    @click="submitComment(post)"
                  >
                    发送
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <div v-if="moments.hasMore" class="py-4 text-center">
          <button
            type="button"
            class="rounded-lg border border-line px-3 py-1 text-[12px] text-muted hover:text-text"
            :disabled="moments.loading"
            @click="moments.loadMore()"
          >
            {{ moments.loading ? '加载中…' : '加载更多' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
