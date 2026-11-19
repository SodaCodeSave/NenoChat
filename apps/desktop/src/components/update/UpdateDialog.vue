<script setup lang="ts">
import { computed } from 'vue'
import Dialog from '@/components/ui/form/Dialog.vue'
import Button from '@/components/ui/form/Button.vue'
import {
  dismissUpdateDialog,
  installUpdate,
  updaterState,
} from '@/composables/use-updater'
import { CLIENT_VERSION } from '@/version'

const state = updaterState()

const title = computed(() => {
  switch (state.status) {
    case 'downloading':
      return '正在下载更新'
    case 'installing':
      return '正在安装更新'
    case 'error':
      return '更新失败'
    default:
      return '发现新版本'
  }
})

/** 下载与安装阶段不可关闭，误触关闭会让半截安装包悬在后台 */
const dismissible = computed(() => state.status !== 'downloading' && state.status !== 'installing')

const percent = computed(() => Math.round(state.progress * 100))
</script>

<template>
  <Dialog
    v-model:open="state.dialogOpen"
    :title="title"
    :dismissible="dismissible"
    width="sm"
    @update:open="(open: boolean) => !open && dismissUpdateDialog()"
  >
    <div class="space-y-3">
      <p class="text-[13px] text-text">
        新版本
        <span class="mx-1 rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[12px] text-text-strong">
          {{ state.version }}
        </span>
        <span class="text-muted">（当前 {{ CLIENT_VERSION }}）</span>
      </p>

      <p
        v-if="state.notes"
        class="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-2.5 text-[12.5px] leading-relaxed text-text"
      >{{ state.notes }}</p>

      <div v-if="state.status === 'downloading' || state.status === 'installing'">
        <div class="h-1.5 overflow-hidden rounded-full bg-surface-2">
          <div
            class="h-full rounded-full bg-accent transition-[width] duration-200"
            :style="{ width: `${percent}%` }"
          />
        </div>
        <p class="mt-1.5 text-right text-[11.5px] text-muted">
          {{ state.status === 'installing' ? '安装中，马上就好…' : `${percent}%` }}
        </p>
      </div>

      <p v-if="state.status === 'error'" class="text-[12.5px] text-danger">{{ state.error }}</p>
    </div>

    <template #footer>
      <Button
        variant="ghost"
        :disabled="state.status === 'downloading' || state.status === 'installing'"
        @click="dismissUpdateDialog"
      >
        {{ state.status === 'error' ? '关闭' : '暂不更新' }}
      </Button>
      <Button
        v-if="state.status === 'available' || state.status === 'error'"
        variant="primary"
        @click="installUpdate"
      >
        立即更新
      </Button>
    </template>
  </Dialog>
</template>
