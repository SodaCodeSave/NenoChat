<script setup lang="ts">
import { computed, ref } from 'vue'
import { ThemeMode } from '@nenochat/shared'
import SettingsCard from '@/components/ui/form/SettingsCard.vue'
import SettingRow from '@/components/ui/form/SettingRow.vue'
import Segmented from '@/components/ui/form/Segmented.vue'
import Switch from '@/components/ui/form/Switch.vue'
import { useUiStore, type LinkDisplay, type MessageStyle } from '@/stores/ui'
import { uploadFile } from '@/api/files'
import { settingsApi } from '@/api/endpoints'
import { resolveFileUrl } from '@/api/http'
import { extractDominantColor } from '@/platform/bg-accent'

const ui = useUiStore()

const accents = [
  { key: 'blue', label: '经典蓝', color: '#2f6bff' },
  { key: 'violet', label: '星河紫', color: '#7c5cff' },
  { key: 'green', label: '松石绿', color: '#16a34a' },
  { key: 'orange', label: '落日橙', color: '#ea7317' },
  { key: 'pink', label: '莓果粉', color: '#db2f85' },
]

const themeOptions = [
  { value: ThemeMode.Light, label: '浅色', icon: 'sun' as const },
  { value: ThemeMode.Dark, label: '深色', icon: 'moon' as const },
  { value: ThemeMode.System, label: '跟随系统', icon: 'settings' as const },
]

const input = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const progress = ref(0)
const error = ref<string | null>(null)
/** 刚选好文件还没传完时先本地预览，传完换回服务端地址 */
const localPreview = ref<string | null>(null)

const bgPreviewUrl = computed(() => localPreview.value ?? resolveFileUrl(ui.chatBgUrl))
const bgLabel = computed(() => (uploading.value ? `上传中 ${progress.value}%` : '上传背景'))

function pick(): void {
  if (uploading.value) return
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
  // 单独跟踪对象 URL：成功路径上预览已切回服务端地址，finally 里也要能 revoke
  const localObjectUrl = URL.createObjectURL(file)
  localPreview.value = localObjectUrl

  try {
    const attachment = await uploadFile(file, {
      kind: 'background',
      onProgress: (percent) => {
        progress.value = percent
      },
    })
    // 主色只在上传设备提取一次，随 user_settings 同步，其它设备启动即用
    const accent = await extractDominantColor(file)
    const { settings } = await settingsApi.update({ chatBgUrl: attachment.url, chatBgAccent: accent })
    ui.setChatBackground(settings.chatBgUrl, settings.chatBgAccent)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '上传失败'
  } finally {
    URL.revokeObjectURL(localObjectUrl)
    localPreview.value = null
    uploading.value = false
  }
}

async function removeBackground(): Promise<void> {
  if (uploading.value) return
  error.value = null
  try {
    await settingsApi.update({ chatBgUrl: null, chatBgAccent: null })
    ui.setChatBackground(null, null)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '移除失败'
  }
}
</script>

<template>
  <div class="space-y-3">
    <SettingsCard id="theme" title="主题" description="切换后立即生效，无需保存" icon="sun">
      <SettingRow label="外观模式" description="跟随系统时，随操作系统的深浅色自动切换" stacked>
        <Segmented
          :model-value="ui.theme"
          :options="themeOptions"
          full
          aria-label="外观模式"
          @update:model-value="ui.setTheme($event as ThemeMode)"
        />
      </SettingRow>

      <SettingRow
        label="主题色"
        description="按钮、链接与选中态会使用这个颜色；设置聊天背景并开启「主题色随背景」后，会改用从背景提取的颜色"
        stacked
      >
        <div class="flex flex-wrap items-center gap-2.5">
          <button
            v-for="accent in accents"
            :key="accent.key"
            type="button"
            class="group relative grid h-8 w-8 place-items-center rounded-full outline-none transition-transform focus-visible:ring-2 focus-visible:ring-accent/25"
            :class="ui.accent === accent.key ? 'scale-110' : 'hover:scale-105'"
            :title="accent.label"
            :aria-label="accent.label"
            :aria-pressed="ui.accent === accent.key"
            @click="ui.setAccent(accent.key)"
          >
            <span
              class="h-full w-full rounded-full border-2 transition-colors"
              :class="ui.accent === accent.key ? 'border-text-strong' : 'border-transparent'"
              :style="{ background: accent.color }"
            />
            <span
              v-if="ui.accent === accent.key"
              class="absolute inset-0 grid place-items-center text-white"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 12.5 9 17.5 20 6.5" />
              </svg>
            </span>
          </button>
          <span class="ml-1 text-[11.5px] text-muted">
            {{ accents.find((item) => item.key === ui.accent)?.label ?? '自定义' }}
          </span>
        </div>
      </SettingRow>
    </SettingsCard>

    <SettingsCard id="background" title="聊天背景" description="背景只在聊天消息区显示，仅自己可见" icon="image">
      <SettingRow label="背景图片" description="支持 PNG / JPEG / WEBP / GIF，最大 10MB" stacked>
        <div class="flex items-center gap-3">
          <div class="h-16 w-24 shrink-0 overflow-hidden rounded-lg border border-line bg-surface-2">
            <img
              v-if="bgPreviewUrl"
              :src="bgPreviewUrl"
              class="h-full w-full object-cover"
              alt="聊天背景预览"
            />
            <div v-else class="grid h-full place-items-center text-[11px] text-muted">未设置</div>
          </div>
          <div class="min-w-0 space-y-1.5">
            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                class="rounded-lg border border-line px-2.5 py-1 text-[12px] text-text hover:bg-surface-3 disabled:opacity-50"
                :disabled="uploading"
                @click="pick"
              >
                {{ bgLabel }}
              </button>
              <button
                v-if="ui.chatBgUrl"
                type="button"
                class="rounded-lg border border-line px-2.5 py-1 text-[12px] text-danger hover:bg-danger/10 disabled:opacity-50"
                :disabled="uploading"
                @click="removeBackground"
              >
                移除
              </button>
            </div>
            <p v-if="error" class="text-[11.5px] text-danger">{{ error }}</p>
          </div>
        </div>
      </SettingRow>

      <SettingRow
        label="主题色随背景"
        description="开启后自动从背景图提取主题色；关闭则使用上面手动选择的主题色"
      >
        <Switch
          :model-value="ui.accentFollowBg"
          aria-label="主题色随背景"
          @update:model-value="ui.setAccentFollowBg"
        />
      </SettingRow>
    </SettingsCard>

    <SettingsCard id="input" title="聊天与输入" icon="message">
      <SettingRow label="消息样式" description="切换消息的排版风格，立即生效" stacked>
        <Segmented
          :model-value="ui.messageStyle"
          full
          :options="[
            { value: 'discord', label: '扁平流式' },
            { value: 'qq', label: 'QQ 气泡' },
          ]"
          aria-label="消息样式"
          @update:model-value="ui.setMessageStyle($event as MessageStyle)"
        />
      </SettingRow>

      <SettingRow label="链接展示" description="聊天里的网页与 B 站视频链接的显示方式" stacked>
        <Segmented
          :model-value="ui.linkDisplay"
          full
          :options="[
            { value: 'card', label: '信息卡片' },
            { value: 'logo', label: 'LOGO + 标题' },
          ]"
          aria-label="链接展示"
          @update:model-value="ui.setLinkDisplay($event as LinkDisplay)"
        />
      </SettingRow>

      <SettingRow label="连接器提示" description="AI 回复里显示“已联网搜索”“已阅读网页”等资料来源小字">
        <Switch
          :model-value="ui.showConnectorHints"
          aria-label="连接器提示"
          @update:model-value="ui.setShowConnectorHints"
        />
      </SettingRow>

      <SettingRow label="发送方式" description="选择按下哪个快捷键时发送消息" stacked>
        <Segmented
          :model-value="ui.sendKey"
          full
          :options="[
            { value: 'enter', label: 'Enter 发送' },
            { value: 'ctrl+enter', label: 'Ctrl + Enter 发送' },
          ]"
          aria-label="发送方式"
          @update:model-value="ui.setSendKey($event as 'enter' | 'ctrl+enter')"
        />
      </SettingRow>
    </SettingsCard>

    <SettingsCard id="motion" title="动效" icon="sparkles">
      <SettingRow label="减少动效" description="关闭过渡与动画，适合容易眩晕或低性能设备">
        <Switch
          :model-value="ui.reduceMotion"
          aria-label="减少动效"
          @update:model-value="ui.setReduceMotion"
        />
      </SettingRow>
    </SettingsCard>

    <input ref="input" type="file" accept="image/*" class="hidden" @change="onChange" />
  </div>
</template>
