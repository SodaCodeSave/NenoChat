<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Avatar from '@/components/ui/Avatar.vue'
import { uploadFile } from '@/api/files'

const props = withDefaults(
  defineProps<{
    src?: string | null
    name?: string | null
    size?: number
    /** 除文件选择外的额外提示，例如「建议 256×256」 */
    hint?: string
    disabled?: boolean
  }>(),
  { size: 56, hint: '', disabled: false },
)

const emit = defineEmits<{
  (e: 'uploaded', url: string): void
}>()

const input = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const progress = ref(0)
const error = ref<string | null>(null)
const preview = ref<string | null>(props.src ?? null)

watch(
  () => props.src,
  (value) => {
    preview.value = value ?? null
  },
)

const label = computed(() => (uploading.value ? `上传中 ${progress.value}%` : '更换头像'))

function pick(): void {
  if (props.disabled || uploading.value) return
  input.value?.click()
}

async function onChange(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  // 允许再次选同一个文件
  target.value = ''
  if (!file) return

  if (!file.type.startsWith('image/')) {
    error.value = '请选择图片文件'
    return
  }
  if (file.size > 10 * 1024 * 1024) {
    error.value = '图片不能超过 10MB'
    return
  }

  error.value = null
  uploading.value = true
  progress.value = 0
  // 先本地预览，上传完再换成服务端地址（同一张图，观感无跳变）
  const localUrl = URL.createObjectURL(file)
  preview.value = localUrl

  try {
    const attachment = await uploadFile(file, {
      kind: 'avatar',
      onProgress: (percent) => {
        progress.value = percent
      },
    })
    preview.value = attachment.url
    emit('uploaded', attachment.url)
  } catch (e) {
    preview.value = props.src ?? null
    error.value = e instanceof Error ? e.message : '上传失败'
  } finally {
    URL.revokeObjectURL(localUrl)
    uploading.value = false
  }
}
</script>

<template>
  <div class="flex items-center gap-3">
    <button
      type="button"
      class="relative rounded-full transition-opacity"
      :class="disabled || uploading ? 'cursor-not-allowed opacity-70' : 'hover:opacity-90'"
      :title="label"
      @click="pick"
    >
      <Avatar :name="name" :src="preview" :seed="name" :size="size" />
      <span
        v-if="uploading"
        class="absolute inset-0 grid place-items-center rounded-full bg-[#0b0b0a]/45 text-[10px] font-medium text-white"
      >
        {{ progress }}%
      </span>
    </button>

    <div class="min-w-0">
      <button
        type="button"
        class="rounded-lg border border-line px-2.5 py-1 text-[12px] text-text hover:bg-surface-3 disabled:opacity-50"
        :disabled="disabled || uploading"
        @click="pick"
      >
        {{ label }}
      </button>
      <p v-if="error" class="mt-1 text-[11.5px] text-danger">{{ error }}</p>
      <p v-else-if="hint" class="mt-1 text-[11.5px] text-muted">{{ hint }}</p>
    </div>

    <input ref="input" type="file" accept="image/*" class="hidden" @change="onChange" />
  </div>
</template>
