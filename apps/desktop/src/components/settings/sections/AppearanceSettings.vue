<script setup lang="ts">
import { ThemeMode } from '@nenochat/shared'
import SettingsCard from '@/components/ui/form/SettingsCard.vue'
import SettingRow from '@/components/ui/form/SettingRow.vue'
import Segmented from '@/components/ui/form/Segmented.vue'
import Switch from '@/components/ui/form/Switch.vue'
import { useUiStore, type LinkDisplay, type MessageStyle } from '@/stores/ui'

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

      <SettingRow label="主题色" description="按钮、链接与选中态会使用这个颜色" stacked>
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
  </div>
</template>
