<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import Icon from '@/components/ui/Icon.vue'
import SettingsCard from '@/components/ui/form/SettingsCard.vue'
import TextInput from '@/components/ui/form/TextInput.vue'
import Button from '@/components/ui/form/Button.vue'
import Switch from '@/components/ui/form/Switch.vue'
import Alert from '@/components/ui/form/Alert.vue'
import ConfirmDialog from '@/components/ui/form/ConfirmDialog.vue'
import { resolveFileUrl } from '@/api/http'
import { useStickersStore } from '@/stores/stickers'

const stickers = useStickersStore()

const activePackId = ref<string>('')
const newPackName = ref('')
const creating = ref(false)
const renamingId = ref<string | null>(null)
const renameDraft = ref('')
const error = ref<string | null>(null)
const pendingRemovePack = ref<string | null>(null)
const removingPack = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const packInput = ref<HTMLInputElement | null>(null)

const activePack = computed(
  () => stickers.packs.find((entry) => entry.pack.id === activePackId.value) ?? stickers.packs[0] ?? null,
)

const pendingPackName = computed(
  () => stickers.packs.find((entry) => entry.pack.id === pendingRemovePack.value)?.pack.name ?? '',
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

async function removePack(): Promise<void> {
  const packId = pendingRemovePack.value
  if (!packId) return
  removingPack.value = true
  try {
    await stickers.removePack(packId)
    if (activePackId.value === packId) activePackId.value = stickers.packs[0]?.pack.id ?? ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : '删除失败'
  } finally {
    removingPack.value = false
    pendingRemovePack.value = null
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
  <div class="space-y-3">
    <Alert v-if="error" tone="danger">{{ error }}</Alert>

    <p class="text-[11.5px] leading-relaxed text-muted">
      上传的图片会存到服务器，所有设备共用同一套表情；聊天输入框的表情面板里可以直接发送。
      开启「允许 AI 使用」后，AI 聊天时会按情绪自己挑表情发，也可以导入 AstrBot 格式的表情包压缩包。
    </p>

    <SettingsCard
      id="packs"
      title="表情包分组"
      :description="activePack ? `当前分组共 ${activePack.stickers.length} 张表情` : '先新建一个分组再上传表情'"
      icon="smile"
    >
      <template #actions>
        <Button
          size="sm"
          icon="sparkles"
          :loading="backfilling || stickers.analyzing > 0"
          :disabled="backfilling || stickers.analyzing > 0"
          title="用识图模型分析表情情绪，AI 挑表情靠这些标签"
          @click="backfill"
        >
          {{ stickers.analyzing > 0 ? `分析中 ${stickers.analyzing}` : 'AI 分析情绪' }}
        </Button>
        <Button
          size="sm"
          icon="folder"
          :loading="importing"
          :disabled="importing"
          title="导入 AstrBot 表情包压缩包"
          @click="packInput?.click()"
        >
          {{ importing ? `导入中 ${importProgress}%` : '导入表情包' }}
        </Button>
        <input
          ref="packInput"
          type="file"
          accept=".zip,application/zip,application/x-zip-compressed"
          class="hidden"
          @change="importPackFile"
        />
      </template>

      <p v-if="importResult || backfillResult" class="mb-2 text-[11.5px] text-muted">
        {{ importResult ?? backfillResult }}
      </p>

      <!-- 分组切换 -->
      <div class="flex flex-wrap items-center gap-1.5">
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
          <TextInput
            v-model="newPackName"
            size="sm"
            placeholder="新分组名"
            class="w-28"
            @keydown.enter="createPack"
          />
          <Button
            size="sm"
            icon="plus"
            :loading="creating"
            :disabled="creating || !newPackName.trim()"
            @click="createPack"
          >
            新建
          </Button>
        </div>
      </div>

      <div v-if="activePack" class="mt-3 rounded-lg border border-line bg-surface-2 p-3">
        <div class="mb-2.5 flex flex-wrap items-center gap-2">
          <template v-if="renamingId === activePack.pack.id">
            <TextInput
              v-model="renameDraft"
              size="sm"
              class="w-40"
              @keydown.enter="commitRename"
            />
            <Button size="sm" variant="primary" @click="commitRename">保存</Button>
            <Button size="sm" variant="ghost" @click="renamingId = null">取消</Button>
          </template>
          <template v-else>
            <p class="text-[13px] font-semibold text-text-strong">{{ activePack.pack.name }}</p>
            <Button
              variant="ghost"
              size="sm"
              icon="edit"
              title="重命名"
              aria-label="重命名分组"
              @click="startRename(activePack.pack.id, activePack.pack.name)"
            />
            <Button
              variant="ghost"
              size="sm"
              icon="trash"
              class="hover:!bg-danger/10 hover:!text-danger"
              title="删除分组"
              aria-label="删除分组"
              @click="pendingRemovePack = activePack.pack.id"
            />

            <label
              v-if="activePack.pack.kind === 'image'"
              class="ml-1 flex cursor-pointer items-center gap-1.5 text-[11.5px] text-muted"
              title="开启后 AI 聊天时可以自己挑这个包里的表情发送"
            >
              <Switch
                size="sm"
                :model-value="activePack.pack.allowAi"
                aria-label="允许 AI 使用这个分组"
                @update:model-value="toggleAllowAi(activePack.pack.id, $event)"
              />
              允许 AI 使用
            </label>

            <Button
              class="ml-auto"
              size="sm"
              variant="primary"
              icon="plus"
              :loading="stickers.uploading"
              :disabled="stickers.uploading"
              @click="fileInput?.click()"
            >
              {{ stickers.uploading ? '上传中…' : '添加表情' }}
            </Button>
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
            class="group relative grid aspect-square place-items-center rounded-lg border border-line bg-surface p-1"
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
              class="absolute right-1 top-1 hidden rounded-full bg-black/60 p-1 text-white transition-colors hover:bg-danger group-hover:block"
              title="删除"
              aria-label="删除表情"
              @click="removeSticker(sticker.id)"
            >
              <Icon name="close" :size="11" />
            </button>
          </div>
        </div>
      </div>

      <p v-else class="mt-3 text-[12.5px] text-muted">正在读取表情包…</p>
    </SettingsCard>

    <ConfirmDialog
      :open="Boolean(pendingRemovePack)"
      title="删除这个表情分组？"
      :description="`「${pendingPackName}」分组及其中的表情会被删除，正在使用这些表情的消息不受影响。`"
      confirm-text="删除分组"
      :loading="removingPack"
      @update:open="(value) => !value && (pendingRemovePack = null)"
      @confirm="removePack"
    />
  </div>
</template>
