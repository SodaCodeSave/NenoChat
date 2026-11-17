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
const packInput = ref<HTMLInputElement | null>(null)

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
  const importedIds: string[] = []
  for (const file of files) {
    try {
      const sticker = await stickers.addSticker(pack.pack.id, file)
      importedIds.push(sticker.id)
    } catch (e) {
      error.value = e instanceof Error ? e.message : '上传失败'
      break
    }
  }
  // 导入完自动排队情绪分析，AI 才能在聊天里挑选这些表情
  for (const id of importedIds) stickers.queueAnalysis(id)
}

async function toggleAllowAi(packId: string, value: boolean): Promise<void> {
  error.value = null
  try {
    await stickers.setPackAllowAi(packId, value)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存失败'
    stickers.load(true).catch(() => undefined)
  }
}

const backfilling = ref(false)
const backfillResult = ref<string | null>(null)

/** 一键补扫所有还没有情绪标签的表情 */
async function backfill(): Promise<void> {
  if (backfilling.value) return
  backfilling.value = true
  backfillResult.value = null
  error.value = null
  try {
    const result = await stickers.backfillAnalysis()
    backfillResult.value =
      result.ok + result.failed === 0
        ? '所有表情都有情绪标签了'
        : `分析完成：成功 ${result.ok} 张${result.failed > 0 ? `，失败 ${result.failed} 张` : ''}`
  } catch (e) {
    error.value = e instanceof Error ? e.message : '补扫失败'
  } finally {
    backfilling.value = false
  }
}

async function removeSticker(id: string): Promise<void> {
  try {
    await stickers.removeSticker(id)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '删除失败'
  }
}

const importing = ref(false)
const importProgress = ref(0)
const importResult = ref<string | null>(null)

/** 导入 AstrBot 格式的表情包 zip：整包交给服务端解压，导入后自动切到新分组 */
async function importPackFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return

  importing.value = true
  importProgress.value = 0
  importResult.value = null
  error.value = null
  try {
    const result = await stickers.importPack(file, {
      onProgress: (percent) => {
        importProgress.value = percent
      },
    })
    importResult.value =
      `已导入 ${result.imported} 张表情到「${result.pack.name}」` +
      (result.skipped > 0 ? `，跳过 ${result.skipped} 张` : '')
    activePackId.value = result.pack.id
  } catch (e) {
    error.value = e instanceof Error ? e.message : '导入失败'
  } finally {
    importing.value = false
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
      上传的图片会存到服务器，所有设备共用同一套表情；聊天输入框的表情面板里可以直接发送。
      开启「允许 AI 使用」后，AI 聊天时会按情绪自己挑表情发。
      也可以直接导入 AstrBot 格式的表情包压缩包（zip，内含 manifest.json 与 memes 目录）。
    </p>

    <div class="mb-3 flex flex-wrap items-center gap-2">
      <button
        type="button"
        class="flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-[12px] text-muted hover:text-text disabled:opacity-50"
        :disabled="backfilling || stickers.analyzing > 0"
        title="用识图模型分析表情情绪，AI 挑表情靠这些标签"
        @click="backfill"
      >
        <Icon name="sparkles" :size="12" />
        {{ stickers.analyzing > 0 ? `分析中…` : 'AI 分析表情情绪' }}
      </button>
      <button
        type="button"
        class="flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-[12px] text-muted hover:text-text disabled:opacity-50"
        :disabled="importing"
        title="导入 AstrBot 表情包压缩包，按 manifest.json 自动建分组并写入分类关键词"
        @click="packInput?.click()"
      >
        <Icon name="folder" :size="12" />
        {{ importing ? `导入中 ${importProgress}%` : '导入表情包' }}
      </button>
      <input
        ref="packInput"
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        class="hidden"
        @change="importPackFile"
      />
      <span v-if="importResult" class="text-[11.5px] text-muted">{{ importResult }}</span>
      <span v-if="backfillResult" class="text-[11.5px] text-muted">{{ backfillResult }}</span>
      <span v-else-if="stickers.analyzing > 0" class="text-[11.5px] text-muted">
        正在分析 {{ stickers.analyzing }} 张，完成后自动保存
      </span>
    </div>

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

          <label
            v-if="activePack.pack.kind === 'image'"
            class="ml-2 flex cursor-pointer items-center gap-1.5 rounded-lg border border-line px-2 py-1"
            title="开启后 AI 聊天时可以自己挑这个包里的表情发送"
          >
            <input
              type="checkbox"
              :checked="activePack.pack.allowAi"
              class="h-3.5 w-3.5 accent-[var(--color-accent)]"
              @change="toggleAllowAi(activePack.pack.id, ($event.target as HTMLInputElement).checked)"
            />
            <span class="text-[11.5px] text-muted">允许 AI 使用</span>
          </label>

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
          :title="sticker.keywords.length > 0 ? sticker.keywords.join('、') : '还没有情绪标签'"
        >
          <img
            v-if="sticker.url"
            :src="resolveFileUrl(sticker.url) ?? ''"
            alt=""
            class="max-h-full max-w-full object-contain"
            loading="lazy"
          />
          <span
            v-if="sticker.keywords.length > 0"
            class="absolute bottom-0.5 left-0.5 right-0.5 truncate rounded bg-black/50 px-0.5 text-center text-[9px] text-white"
          >
            {{ sticker.keywords.slice(0, 3).join('、') }}
          </span>
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
