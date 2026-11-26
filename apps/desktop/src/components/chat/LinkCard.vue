<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import type { LinkPreview } from '@nenochat/shared'
import Icon from '@/components/ui/Icon.vue'
import { connectorApi } from '@/api/connectors'
import { loadLinkPreviewCached } from '@/composables/link-preview'

const props = defineProps<{ url: string }>()

const preview = ref<LinkPreview | null>(null)
const loaded = ref(false)
const imageLoaded = ref(false)
const imageFailed = ref(false)
const expanded = ref(false)
const summary = ref<string | null>(null)
const summaryLoading = ref(false)
const summaryError = ref<string | null>(null)

async function load(): Promise<void> {
  loaded.value = false
  preview.value = await loadLinkPreviewCached(props.url)
  loaded.value = true
}

async function toggleSummary(): Promise<void> {
  if (expanded.value) {
    expanded.value = false
    return
  }
  expanded.value = true
  if (summary.value !== null || !preview.value?.videoId) return

  summaryLoading.value = true
  summaryError.value = null
  try {
    const result = await connectorApi.bilibiliSummary(preview.value.videoId)
    summary.value = result.summary
  } catch (e) {
    summaryError.value = e instanceof Error ? e.message : '读取总结失败'
  } finally {
    summaryLoading.value = false
  }
}

watch(
  () => props.url,
  () => {
    expanded.value = false
    summary.value = null
    summaryError.value = null
    imageFailed.value = false
    imageLoaded.value = false
    void load()
  },
)

onMounted(() => {
  void load()
})
</script>

<template>
  <a
    v-if="preview"
    :href="preview.url"
    target="_blank"
    rel="noreferrer"
    class="block max-w-[420px] overflow-hidden rounded-lg bg-surface-2 transition-colors hover:bg-surface-3"
    @click.stop
  >
    <div class="flex gap-2.5 p-2.5">
      <div class="min-w-0 flex-1">
        <p class="flex items-center gap-1 text-[10.5px] text-muted">
          <Icon name="globe" :size="11" class="shrink-0" />
          <span class="truncate">{{ preview.siteName ?? '网页' }}</span>
          <span
            v-if="preview.kind === 'bilibili'"
            class="shrink-0 rounded bg-[#fb7299]/12 px-1 text-[10px] text-[#fb7299]"
          >
            视频
          </span>
        </p>
        <p class="mt-0.5 line-clamp-2 text-[12.5px] font-medium leading-snug text-text-strong">
          {{ preview.title ?? preview.url }}
        </p>
        <p
          v-if="preview.description"
          class="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted"
        >
          {{ preview.description }}
        </p>
        <p v-if="preview.author" class="mt-1 truncate text-[10.5px] text-muted">
          UP 主：{{ preview.author }}
        </p>
      </div>

      <img
        v-if="preview.image && !imageFailed"
        :src="preview.image"
        alt=""
        class="img-fade h-[68px] w-[96px] shrink-0 rounded-md object-cover"
        :data-loaded="imageLoaded ? 'true' : 'false'"
        loading="lazy"
        referrerpolicy="no-referrer"
        @load="imageLoaded = true"
        @error="imageFailed = true"
      />
    </div>
  </a>

  <div
    v-if="preview?.kind === 'bilibili'"
    class="ml-1 max-w-[420px]"
  >
    <button
      type="button"
      class="mt-1 flex items-center gap-1 text-[11px] text-accent hover:underline"
      :aria-expanded="expanded"
      @click.stop="toggleSummary"
    >
      <Icon
        name="chevronDown"
        :size="11"
        class="transition-transform duration-200 ease-out"
        :class="expanded ? 'rotate-180' : ''"
      />
      {{ expanded ? '收起总结' : '查看总结' }}
    </button>
    <!-- 折叠靠 grid 轨道 0fr ↔ 1fr 过渡，不测内容高度 -->
    <div
      class="grid transition-[grid-template-rows] duration-200 ease-out"
      :class="expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'"
      :aria-hidden="!expanded"
    >
      <div class="overflow-hidden">
        <div class="mt-1 rounded-lg bg-surface px-2.5 py-2 text-[11.5px] leading-relaxed text-text">
          <p v-if="summaryLoading" class="text-muted">读取中…</p>
          <p v-else-if="summaryError" class="text-danger">{{ summaryError }}</p>
          <p v-else-if="summary" class="whitespace-pre-wrap">{{ summary }}</p>
          <p v-else class="text-muted">
            还没有生成总结。在 AI 会话里发送这条链接后，总结会自动生成并缓存。
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
