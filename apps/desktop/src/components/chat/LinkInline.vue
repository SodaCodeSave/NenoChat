<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { isBilibiliUrl, type LinkPreview } from '@nenochat/shared'
import Icon from '@/components/ui/Icon.vue'
import { connectorPresetOf } from '@/config/connectors'
import { loadLinkPreviewCached } from '@/composables/link-preview'

/** inheritColor：跟随正文颜色（自己的 QQ 气泡里用白色），默认用链接色 */
const props = withDefaults(
  defineProps<{ url: string; inheritColor?: boolean }>(),
  { inheritColor: false },
)

/** B 站直接用官方彩色图标，其他站点请求站点根目录的 favicon */
const bilibiliIcon = connectorPresetOf('bilibili')?.icon ?? null

const isBilibili = computed(() => isBilibiliUrl(props.url))

const faviconUrl = computed(() => {
  try {
    return `${new URL(props.url).origin}/favicon.ico`
  } catch {
    return null
  }
})

/** favicon 加载失败时退化为地球图标，不反复重试 */
const faviconFailed = ref(false)

const preview = ref<LinkPreview | null>(null)

async function load(): Promise<void> {
  faviconFailed.value = false
  preview.value = await loadLinkPreviewCached(props.url)
}

watch(() => props.url, () => void load())
onMounted(() => void load())

/** 短链接兜底：标题取到前先显示去掉协议与 www 的地址 */
const shortUrl = computed(() => {
  let text: string
  try {
    const parsed = new URL(props.url)
    text = parsed.host.replace(/^www\./, '') + parsed.pathname + parsed.search
  } catch {
    text = props.url
  }
  text = text.replace(/\/$/, '')
  return text.length > 48 ? `${text.slice(0, 48)}…` : text
})

const title = computed(() => preview.value?.title ?? shortUrl.value)
</script>

<template>
  <a
    :href="url"
    target="_blank"
    rel="noreferrer"
    :title="url"
    class="inline-flex max-w-[320px] items-center gap-1 align-middle hover:underline"
    :class="inheritColor ? 'text-current' : 'text-accent'"
  >
    <img
      v-if="isBilibili && bilibiliIcon"
      :src="bilibiliIcon"
      alt=""
      class="h-[15px] w-[15px] shrink-0 object-contain"
      loading="lazy"
    />
    <img
      v-else-if="faviconUrl && !faviconFailed"
      :src="faviconUrl"
      alt=""
      class="h-[15px] w-[15px] shrink-0 object-contain"
      loading="lazy"
      referrerpolicy="no-referrer"
      @error="faviconFailed = true"
    />
    <Icon v-else name="globe" :size="13" class="shrink-0 opacity-70" />

    <span class="truncate">{{ title }}</span>
    <span
      v-if="isBilibili"
      class="shrink-0 rounded bg-[#fb7299]/12 px-1 text-[10px] text-[#fb7299]"
    >
      视频
    </span>
  </a>
</template>
