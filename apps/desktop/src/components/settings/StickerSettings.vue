<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import Icon from '@/components/ui/Icon.vue'
import { resolveFileUrl } from '@/api/http'
import { useStickersStore } from '@/stores/stickers'

const stickers = useStickersStore()

const activePackId = ref<string>('')
const newPackName = ref('')
const creating = ref(false)
const renamingId = ref<string | null>(null)
const renameDraft = ref('')
const error = ref<string | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

const activePack = computed(
  () => stickers.packs.find((entry) => entry.pack.id === activePackId.value) ?? stickers.packs[0] ?? null,
)

async function load(): Promise<void> {
  await stickers.load(true)
  if (!activePackId.value && stickers.packs[0]) activePackId.value = stickers.packs[0].pack.id
}

async function createPack(): Promise<void> {
  const name = newPackName.value.trim()
  if (!name) return
  creating.value = true
  error.value = null
  try {
    await stickers.createPack(name)
    newPackName.value = ''
    const created = stickers.packs[stickers.packs.length - 1]
    if (created) activePackId.value = created.pack.id
  } catch (e) {
    error.value = e instanceof Error ? e.message : '创建分组失败'
  } finally {
    creating.value = false
  }
}

function startRename(packId: string, current: string): void {
  renamingId.value = packId
  renameDraft.value = current
}

async function commitRename(): Promise<void> {
  const id = renamingId.value
  const name = renameDraft.value.trim()
  renamingId.value = null
  if (!id || !name) return
  try {
    await stickers.renamePack(id, name)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '重命名失败'
  }
}

async function removePack(packId: string): Promise<void> {
  if (!window.confirm('删除这个分组？分组里不能有表情')) return
  try {
    await stickers.removePack(packId)
    if (activePackId.value === packId) activePackId.value = stickers.packs[0]?.pack.id ?? ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : '删除失败'
  }
}

async function pickFiles(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  const pack = activePack.value
  if (!pack || files.length === 0) return

  error.value = null
  for (const file of files) {
    try {
      await stickers.addSticker(pack.pack.id, file)
    } catch (e) {
      error.value = e instanceof Error ? e.message : '上传失败'
      break
    }
  }
}

async function removeSticker(id: string): Promise<void> {
  try {
    await stickers.removeSticker(id)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '删除失败'
  }
}

onMounted(() => {
  void load()
})
</script>

<template>
  <section>
    <h2 class="mb-1 text-[15px] font-semibold text-text-strong">表情包</h2>
    <p class="mb-4 text-[12px] text-muted">
      上传的图片会存到服务器，所有设备共用同一套表情；聊天输入框的表情面板里可以直接发送
    </p>

    <!-- 分组 -->
    <div class="mb-3 flex flex-wrap items-center gap-1.5">
      <button
        v-for="entry in stickers.packs"
        :key="entry.pack.id"
        type="button"
        class="rounded-lg px-2.5 py-1 text-[12.5px] transition-colors"
        :class="
          activePack?.pack.id === entry.pack.id
            ? 'bg-accent text-accent-text'
            : 'border border-line bg-surface-2 text-muted hover:text-text'
        "
        @click="activePackId = entry.pack.id"
      >
        {{ entry.pack.name }}
        <span class="ml-1 text-[10.5px] opacity-70">{{ entry.stickers.length }}</span>
      </button>

      <div class="ml-auto flex items-center gap-1">
        <input
          v-model="newPackName"
          placeholder="新分组名"
          class="h-7 w-24 rounded-lg border border-line bg-surface-2 px-2 text-[12px] outline-none focus:border-accent"
          @keydown.enter="createPack"
        />
        <button
          type="button"
          class="flex items-center gap-0.5 rounded-lg border border-line px-2 py-1 text-[12px] text-muted hover:text-text disabled:opacity-50"
          :disabled="creating || !newPackName.trim()"
          @click="createPack"
        >
          <Icon name="plus" :size="12" />
          新建
        </button>
      </div>
    </div>

    <p v-if="error" class="mb-2 text-[12px] text-danger">{{ error }}</p>

    <div v-if="activePack" class="rounded-xl border border-line bg-surface p-3">
      <div class="mb-2 flex items-center gap-2">
        <template v-if="renamingId === activePack.pack.id">
          <input
            v-model="renameDraft"
            class="h-7 w-40 rounded-lg border border-line bg-surface-2 px-2 text-[12.5px] outline-none focus:border-accent"
            @keydown.enter="commitRename"
          />
          <button
            type="button"
            class="rounded-lg bg-accent px-2 py-1 text-[12px] text-accent-text"
            @click="commitRename"
          >
            保存
          </button>
          <button
            type="button"
            class="rounded-lg border border-line px-2 py-1 text-[12px] text-muted"
            @click="renamingId = null"
          >
            取消
          </button>
        </template>
        <template v-else>
          <p class="text-[13px] font-medium text-text-strong">{{ activePack.pack.name }}</p>
          <button
            type="button"
            class="rounded p-1 text-muted hover:bg-surface-2 hover:text-text"
            title="重命名"
            @click="startRename(activePack.pack.id, activePack.pack.name)"
          >
            <Icon name="edit" :size="13" />
          </button>
          <button
            type="button"
            class="rounded p-1 text-muted hover:bg-danger/10 hover:text-danger"
            title="删除分组"
            @click="removePack(activePack.pack.id)"
          >
            <Icon name="trash" :size="13" />
          </button>
          <button
            type="button"
            class="ml-auto flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1 text-[12px] font-medium text-accent-text disabled:opacity-50"
            :disabled="stickers.uploading"
            @click="fileInput?.click()"
          >
            <Icon name="plus" :size="12" />
            {{ stickers.uploading ? '上传中…' : '添加表情' }}
          </button>
          <input
            ref="fileInput"
            type="file"
            accept="image/*"
            multiple
            class="hidden"
            @change="pickFiles"
          />
        </template>
      </div>

      <div v-if="activePack.stickers.length === 0" class="py-8 text-center">
        <Icon name="smile" :size="24" class="mx-auto mb-2 text-muted opacity-50" />
        <p class="text-[12.5px] text-muted">还没有表情，点「添加表情」上传图片</p>
      </div>

      <div v-else class="grid grid-cols-5 gap-2 sm:grid-cols-6">
        <div
          v-for="sticker in activePack.stickers"
          :key="sticker.id"
          class="group relative grid aspect-square place-items-center rounded-lg border border-line bg-surface-2 p-1"
        >
          <img
            v-if="sticker.url"
            :src="resolveFileUrl(sticker.url) ?? ''"
            alt=""
            class="max-h-full max-w-full object-contain"
            loading="lazy"
          />
          <button
            type="button"
            class="absolute top-1 right-1 hidden rounded-full bg-black/60 p-1 text-white group-hover:block"
            title="删除"
            @click="removeSticker(sticker.id)"
          >
            <Icon name="close" :size="11" />
          </button>
        </div>
      </div>
    </div>

    <p v-else class="text-[12.5px] text-muted">正在读取表情包…</p>
  </section>
</template>
