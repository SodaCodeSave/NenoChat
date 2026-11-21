<script setup lang="ts">
import { computed, ref } from 'vue'
import Avatar from '@/components/ui/Avatar.vue'
import Icon from '@/components/ui/Icon.vue'
import { uploadFile } from '@/api/files'
import { resolveFileUrl } from '@/api/http'
import { useAuthStore } from '@/stores/auth'
import { useMomentsStore } from '@/stores/moments'
import { useUiStore } from '@/stores/ui'

/**
 * 动态发布框：桌面端内嵌在信息流顶部常驻显示，
 * 手机端复用同一份逻辑放进发帖弹窗（bare 去掉自带卡片壳）。
 */
withDefaults(defineProps<{ bare?: boolean }>(), { bare: false })

const emit = defineEmits<{ published: [] }>()

const auth = useAuthStore()
const moments = useMomentsStore()
const ui = useUiStore()

const draft = ref('')
const pendingImages = ref<Array<{ id: string; url: string; name: string }>>([])
const uploading = ref(false)
const uploadError = ref<string | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

const canPublish = computed(
  () => (draft.value.trim().length > 0 || pendingImages.value.length > 0) && !moments.publishing,
)

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
    emit('published')
  } catch {
    /* 错误已写进 store.error */
  }
}
</script>

<template>
  <section :class="bare ? '' : 'rounded-2xl border border-line bg-surface p-3'">
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
</template>
