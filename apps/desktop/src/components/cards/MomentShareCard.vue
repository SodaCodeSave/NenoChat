<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { MomentCard } from '@nenochat/shared'
import Avatar from '@/components/ui/Avatar.vue'
import Icon from '@/components/ui/Icon.vue'
import { resolveFileUrl } from '@/api/http'

/**
 * 转发卡片标准规格：固定宽度、可选封面、作者行 + 类型徽标、两行摘要、底部动作行。
 * 后续新增转发类卡片沿用同一套结构与字号档位，尺寸不要各写各的。
 */
const props = defineProps<{ card: MomentCard }>()

const href = computed(() => `#/moments?post=${encodeURIComponent(props.card.postId)}`)
const coverUrl = computed(() => resolveFileUrl(props.card.coverUrl ?? null))
const excerpt = computed(() => props.card.excerpt.trim())

const coverLoaded = ref(false)
const coverFailed = ref(false)

// 换消息复用同一个组件实例时重置封面状态，避免上一张图的加载结果显示在新卡片上
watch(coverUrl, () => {
  coverLoaded.value = false
  coverFailed.value = false
})
</script>

<template>
  <a
    :href="href"
    data-card="moment"
    class="block w-[240px] max-w-full overflow-hidden rounded-xl border border-line bg-surface no-underline transition-colors hover:border-accent/45 hover:bg-surface-2/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 active:bg-surface-2"
  >
    <div
      v-if="coverUrl && !coverFailed"
      class="h-28 overflow-hidden border-b border-line/70 bg-surface-2"
    >
      <img
        :src="coverUrl"
        alt="动态封面"
        class="img-fade h-full w-full object-cover"
        :data-loaded="coverLoaded ? 'true' : 'false'"
        loading="lazy"
        @load="coverLoaded = true"
        @error="coverFailed = true"
      />
    </div>

    <div class="px-3 py-2.5">
      <div class="flex items-center gap-2">
        <Avatar
          :name="card.authorName"
          :src="card.authorAvatarUrl ?? null"
          :seed="card.postId"
          :size="18"
        />
        <span class="min-w-0 flex-1 truncate text-[12px] font-medium text-text-strong">
          {{ card.authorName }}
        </span>
        <span class="shrink-0 rounded bg-surface-3 px-1 text-[10px] leading-[15px] text-muted">
          动态
        </span>
      </div>

      <p v-if="excerpt" class="mt-1.5 line-clamp-2 text-[13px] leading-[1.55] text-text">
        {{ excerpt }}
      </p>
      <p v-else class="mt-1.5 text-[13px] leading-[1.55] text-muted">[无正文]</p>

      <div class="mt-2 flex items-center justify-end border-t border-line/70 pt-1.5">
        <span class="flex items-center gap-0.5 text-[11px] text-accent">
          查看动态
          <Icon name="chevronRight" :size="10" />
        </span>
      </div>
    </div>
  </a>
</template>
