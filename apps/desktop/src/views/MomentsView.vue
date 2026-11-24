<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { buildMomentShareContent, type MomentCard, type Post, type PostComment } from '@nenochat/shared'
import Avatar from '@/components/ui/Avatar.vue'
import Icon from '@/components/ui/Icon.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import Dialog from '@/components/ui/form/Dialog.vue'
import ForwardDialog from '@/components/chat/ForwardDialog.vue'
import MomentsComposer from '@/components/moments/MomentsComposer.vue'
import { uploadFile } from '@/api/files'
import { resolveFileUrl } from '@/api/http'
import { userApi } from '@/api/endpoints'
import { useAiStore } from '@/stores/ai'
import { useAuthStore } from '@/stores/auth'
import { useConversationsStore } from '@/stores/conversations'
import { useMessagesStore } from '@/stores/messages'
import { useMomentsStore } from '@/stores/moments'
import { useUiStore } from '@/stores/ui'

const auth = useAuthStore()
const ai = useAiStore()
const conversations = useConversationsStore()
const moments = useMomentsStore()
const messages = useMessagesStore()
const ui = useUiStore()
const route = useRoute()

// 手机端发帖弹窗：与桌面常驻发布框共用同一份 MomentsComposer
const composerOpen = ref(false)

// 分享弹窗：复用会话选择器，把动态作为卡片发到选中的会话
const shareOpen = ref(false)
const sharingPost = ref<Post | null>(null)
const highlightedPostId = ref<string | null>(null)
const commentDrafts = ref<Record<string, string>>({})
const openCommentInputs = ref<Record<string, boolean>>({})

// 空间头图：点头图直接换，走 background 附件 + users.banner_url
const bannerInput = ref<HTMLInputElement | null>(null)
const bannerUploading = ref(false)
const bannerError = ref<string | null>(null)
/** 刚选好文件还没传完时先本地预览，传完换回服务端地址 */
const bannerPreview = ref<string | null>(null)

const bannerUrl = computed(() => bannerPreview.value ?? auth.user?.bannerUrl ?? null)
const bannerStyle = computed(() =>
  bannerUrl.value
    ? undefined
    : {
        background:
          'linear-gradient(115deg, var(--accent-soft) 0%, color-mix(in srgb, var(--accent) 34%, var(--surface)) 58%, color-mix(in srgb, var(--accent) 62%, var(--surface)) 100%)',
      },
)

function pickBanner(): void {
  if (bannerUploading.value) return
  bannerInput.value?.click()
}

async function onBannerChange(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  // 允许再次选同一个文件
  target.value = ''
  if (!file) return
  if (!file.type.startsWith('image/')) {
    bannerError.value = '头图需要是图片文件'
    return
  }
  if (file.size > 10 * 1024 * 1024) {
    bannerError.value = '图片不能超过 10MB'
    return
  }

  bannerError.value = null
  bannerUploading.value = true
  const localObjectUrl = URL.createObjectURL(file)
  bannerPreview.value = localObjectUrl
  try {
    const attachment = await uploadFile(file, { kind: 'background' })
    const result = await userApi.updateProfile({ bannerUrl: attachment.url })
    if (auth.user) auth.user.bannerUrl = result.user.bannerUrl ?? attachment.url
  } catch (e) {
    bannerError.value = e instanceof Error ? e.message : '头图上传失败'
  } finally {
    URL.revokeObjectURL(localObjectUrl)
    bannerPreview.value = null
    bannerUploading.value = false
  }
}

function feedTime(ts: number): string {
  const date = new Date(ts)
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const today = new Date()
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  if (ts >= startOfToday) return `今天 ${time}`
  if (ts >= startOfToday - 86_400_000) return `昨天 ${time}`
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`
}

function postAuthorName(post: Post): string {
  return post.author?.displayName ?? '用户'
}

function replyAuthorName(postId: string, comment: PostComment): string {
  if (!comment.replyToCommentId) return ''
  const target = (moments.comments[postId] ?? []).find((item) => item.id === comment.replyToCommentId)
  return target ? (target.author?.displayName ?? '用户') : '某条评论'
}

function openShare(post: Post): void {
  sharingPost.value = post
  shareOpen.value = true
}

async function shareTo(targets: string[]): Promise<void> {
  const post = sharingPost.value
  if (!post) return
  const cover = post.attachments?.[0] ?? null
  const coverUrl = cover?.thumbUrl || cover?.url || null
  const excerpt = post.content.replace(/\s+/g, ' ').trim().slice(0, 80) || '[图片]'
  const card: MomentCard = {
    postId: post.id,
    authorName: postAuthorName(post),
    authorAvatarUrl: post.author?.avatarUrl ?? null,
    excerpt,
    coverUrl,
  }
  const content = buildMomentShareContent({
    postId: post.id,
    authorName: card.authorName,
    content: post.content || '[图片]',
    coverUrl,
  })
  await Promise.all(
    targets.map((conversationId) => {
      // AI 会话走完整回合：用户消息带上卡片 meta，服务端同时拿到正文触发回复
      if (conversations.byId.get(conversationId)?.type === 'ai') {
        return ai.sendTurn(conversationId, content, null, [], { momentCard: card })
      }
      return messages.send({ conversationId, content, meta: { momentCard: card } })
    }),
  )
  sharingPost.value = null
}

function toggleCommentInput(postId: string): void {
  openCommentInputs.value[postId] = !openCommentInputs.value[postId]
}

async function submitComment(post: Post): Promise<void> {
  const content = (commentDrafts.value[post.id] ?? '').trim()
  if (!content) return
  commentDrafts.value = { ...commentDrafts.value, [post.id]: '' }
  try {
    await moments.addComment(post.id, content)
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

async function focusPostFromRoute(): Promise<void> {
  const postId = typeof route.query.post === 'string' ? route.query.post : null
  if (!postId) return
  if (!(await moments.focus(postId))) return
  highlightedPostId.value = postId
  await nextTick()
  document.querySelector(`[data-post-id="${postId}"]`)?.scrollIntoView({ block: 'center' })
  window.setTimeout(() => {
    if (highlightedPostId.value === postId) highlightedPostId.value = null
  }, 2500)
}

onMounted(async () => {
  await moments.load(true)
  await focusPostFromRoute()
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
        <!-- 空间头：头图 + 头像 + 签名，签名复用个人资料的 bio -->
        <section class="overflow-hidden rounded-2xl border border-line bg-surface">
          <button
            type="button"
            class="group relative block h-28 w-full md:h-36"
            :disabled="bannerUploading"
            :title="bannerUrl ? '更换头图' : '设置头图'"
            @click="pickBanner"
          >
            <img
              v-if="bannerUrl"
              :src="resolveFileUrl(bannerUrl) ?? ''"
              alt="空间头图"
              class="h-full w-full object-cover"
            />
            <span v-else class="block h-full w-full" :style="bannerStyle" />
            <span
              class="absolute inset-0 hidden items-center justify-center gap-1.5 bg-black/45 text-[12.5px] font-medium text-white transition-opacity group-hover:opacity-100 md:flex"
              :class="bannerUploading ? 'opacity-100' : 'opacity-0'"
            >
              <Icon name="camera" :size="15" />
              {{ bannerUploading ? '上传中…' : '更换头图' }}
            </span>
            <span
              class="absolute right-2 bottom-2 flex items-center gap-1 rounded-full bg-black/55 px-2.5 py-1 text-[11px] text-white md:hidden"
            >
              <Icon name="camera" :size="12" />
              {{ bannerUploading ? '上传中…' : bannerUrl ? '更换头图' : '设置头图' }}
            </span>
          </button>

          <div class="flex items-end gap-3 px-4 pb-3">
            <Avatar
              :name="auth.user?.displayName ?? '我'"
              :src="auth.user?.avatarUrl ?? null"
              :seed="auth.user?.id ?? 'me'"
              :size="56"
              ring
              class="-mt-7"
            />
            <div class="min-w-0 pb-1">
              <p class="truncate text-[14.5px] font-semibold text-text-strong">
                {{ auth.user?.displayName ?? '我' }}
              </p>
              <p class="truncate text-[12px] leading-[1.6] text-muted">
                {{ auth.user?.bio || '这个人很懒，什么都没有写' }}
              </p>
            </div>
          </div>

          <input
            ref="bannerInput"
            type="file"
            accept="image/*"
            class="hidden"
            @change="onBannerChange"
          />
          <p v-if="bannerError" class="px-4 pb-2 text-[11.5px] text-danger">{{ bannerError }}</p>
        </section>

        <!-- 发布框：桌面端常驻内嵌；手机端紧凑条点开弹窗发帖 -->
        <MomentsComposer v-if="!ui.isMobile" class="mt-3" />

        <button
          v-else
          type="button"
          class="mt-3 flex w-full items-center gap-3 rounded-2xl border border-line bg-surface px-3 py-2.5 text-left active:bg-surface-2"
          @click="composerOpen = true"
        >
          <Avatar
            :name="auth.user?.displayName ?? '我'"
            :src="auth.user?.avatarUrl ?? null"
            :seed="auth.user?.id ?? 'me'"
            :size="32"
          />
          <span class="min-w-0 flex-1 truncate text-[12.5px] text-muted">分享点什么…</span>
          <Icon name="image" :size="16" class="text-muted" />
        </button>

        <Dialog v-model:open="composerOpen" title="发动态" width="md">
          <MomentsComposer bare @published="composerOpen = false" />
        </Dialog>

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
          :data-post-id="post.id"
          class="border-b border-line/70 px-1 py-3"
          :class="post.id === highlightedPostId ? 'rounded-xl bg-accent-soft/40' : ''"
        >
          <div class="flex items-start gap-2.5">
            <Avatar
              :name="postAuthorName(post)"
              :src="post.author?.avatarUrl ?? null"
              :seed="post.authorId"
              :size="38"
            />
            <div class="min-w-0 flex-1">
              <div class="flex items-start gap-2">
                <div class="min-w-0 flex-1">
                  <p class="truncate text-[14px] font-medium text-text-strong">
                    {{ postAuthorName(post) }}
                  </p>
                  <span
                    v-if="post.personaId"
                    class="mt-0.5 inline-block rounded bg-mention-soft px-1 text-[10px] text-mention"
                  >
                    AI
                  </span>
                </div>
                <button
                  v-if="isMine(post)"
                  type="button"
                  class="rounded p-1 text-muted hover:bg-danger/10 hover:text-danger"
                  title="删除这条动态"
                  @click="removePost(post)"
                >
                  <Icon name="dots" :size="16" />
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
                class="mt-2"
                :class="post.attachments.length === 1 ? '' : 'grid w-[240px] grid-cols-3 gap-1'"
              >
                <a
                  v-for="attachment in post.attachments"
                  :key="attachment.id"
                  :href="resolveFileUrl(attachment.url) ?? '#'"
                  target="_blank"
                  rel="noreferrer"
                  class="block overflow-hidden rounded border border-line"
                  :class="post.attachments.length === 1 ? 'w-fit' : 'aspect-square'"
                >
                  <img
                    :src="resolveFileUrl(attachment.thumbUrl || attachment.url) ?? ''"
                    :alt="attachment.filename"
                    class="block max-h-[220px] max-w-[190px] object-contain"
                    :class="post.attachments.length === 1 ? '' : 'h-full w-full object-cover'"
                    loading="lazy"
                  />
                </a>
              </div>

              <div class="mt-2.5 flex items-center justify-between gap-3">
                <span class="text-[11.5px] text-muted">{{ feedTime(post.createdAt) }}</span>
                <div class="flex items-center gap-4 text-muted">
                  <button
                    type="button"
                    class="p-1 transition-colors hover:text-[#576b95]"
                    :class="post.likedByMe ? 'text-[#576b95]' : ''"
                    title="赞"
                    @click="moments.toggleLike(post)"
                  >
                    <Icon name="thumbUp" :size="16" />
                  </button>
                  <button
                    type="button"
                    class="p-1 transition-colors hover:text-text"
                    :class="openCommentInputs[post.id] ? 'text-[#576b95]' : ''"
                    title="评论"
                    @click="toggleCommentInput(post.id)"
                  >
                    <Icon name="comment" :size="16" />
                  </button>
                  <button
                    type="button"
                    class="p-1 transition-colors hover:text-[#576b95]"
                    title="分享给好友"
                    @click="openShare(post)"
                  >
                    <Icon name="forward" :size="16" />
                  </button>
                </div>
              </div>

              <div
                v-if="(post.likers ?? []).length > 0"
                class="mt-1.5 flex items-start gap-1 text-[12px] leading-[1.55] text-[#576b95]"
              >
                <Icon name="thumbUp" :size="12" class="mt-0.5 shrink-0" />
                <span class="min-w-0 break-words">
                  {{ (post.likers ?? []).map((liker) => liker.name).join('、') }}
                </span>
              </div>

              <!-- 评论区 -->
              <div class="mt-2 rounded-lg bg-surface-2/70 p-2">
                <div
                  v-for="comment in moments.comments[post.id] ?? []"
                  :key="comment.id"
                  class="group flex items-start gap-1 py-0.5"
                >
                  <p class="min-w-0 flex-1 text-[12.5px] leading-[1.6] break-words text-text"><span class="font-medium text-text-strong">{{ comment.author?.displayName ?? '用户' }}</span><template v-if="replyAuthorName(post.id, comment)"> 回复 <span class="font-medium text-text-strong">{{ replyAuthorName(post.id, comment) }}</span></template><span v-if="comment.personaId" class="mx-1 text-[10px] text-muted">AI</span>：{{ comment.content }}</p>
                  <button
                    v-if="comment.authorId === auth.user?.id || isMine(post)"
                    type="button"
                    class="p-0.5 text-muted hover:text-danger"
                    :class="ui.isMobile ? 'block' : 'hidden group-hover:block'"
                    title="删除评论"
                    @click="removeComment(post.id, comment.id)"
                  >
                    <Icon name="close" :size="11" />
                  </button>
                </div>
                <p
                  v-if="(moments.comments[post.id] ?? []).length === 0"
                  class="py-0.5 text-[11.5px] text-muted"
                >
                  暂无评论，来说两句
                </p>

                <div v-if="openCommentInputs[post.id]" class="mt-1.5 flex items-center gap-2">
                  <input
                    :value="commentDrafts[post.id] ?? ''"
                    placeholder="说点什么…"
                    class="h-9 flex-1 rounded-xl border border-line bg-surface-2 px-3 text-[13.5px] outline-none focus:border-accent"
                    @input="commentDrafts[post.id] = ($event.target as HTMLInputElement).value"
                    @keydown.enter.prevent="submitComment(post)"
                  />
                  <button
                    type="button"
                    class="rounded-lg bg-accent px-3 py-1 text-[12.5px] font-medium text-accent-text disabled:opacity-50"
                    :disabled="!(commentDrafts[post.id] ?? '').trim()"
                    @click="submitComment(post)"
                  >
                    发送
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <ForwardDialog
          v-model:open="shareOpen"
          title="分享动态到"
          hint="选择要分享的会话"
          :message-count="1"
          :perform="shareTo"
        />

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
