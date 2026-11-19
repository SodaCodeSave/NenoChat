<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import QRCode from 'qrcode'
import SettingsCard from '@/components/ui/form/SettingsCard.vue'
import SettingRow from '@/components/ui/form/SettingRow.vue'
import Switch from '@/components/ui/form/Switch.vue'
import Button from '@/components/ui/form/Button.vue'
import SvgIcon from '@/components/ui/SvgIcon.vue'
import { pairingApi } from '@/api/endpoints'
import { localServerInfo, setLanAccess } from '@/platform/local-server'

const enabled = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
const lanUrl = ref<string | null>(null)
const code = ref<string | null>(null)
const expiresAt = ref(0)
const qrSvg = ref<string | null>(null)
const now = ref(Date.now())

let ticker: ReturnType<typeof setInterval> | null = null

/** 剩余有效期（秒）：二维码过期后手机扫码会被服务端拒绝 */
const remaining = computed(() => Math.max(0, Math.ceil((expiresAt.value - now.value) / 1000)))

/** 二维码内容：手机扫码后由系统唤起客户端，客户端拿 url + code 换会话 */
const pairLink = computed(() => {
  if (!lanUrl.value || !code.value) return null
  const params = new URLSearchParams({ url: lanUrl.value, code: code.value, name: 'NenoChat 一体版' })
  return `nenochat://pair?${params.toString()}`
})

async function renderQr(): Promise<void> {
  if (!pairLink.value) {
    qrSvg.value = null
    return
  }
  qrSvg.value = await QRCode.toString(pairLink.value, {
    type: 'svg',
    margin: 0,
    errorCorrectionLevel: 'M',
  })
}

async function requestCode(): Promise<void> {
  error.value = null
  try {
    const issued = await pairingApi.code()
    code.value = issued.code
    expiresAt.value = issued.expiresAt
    now.value = Date.now()
    await renderQr()
  } catch (e) {
    code.value = null
    qrSvg.value = null
    error.value = e instanceof Error ? e.message : '获取配对码失败'
  }
}

async function toggle(next: boolean): Promise<void> {
  busy.value = true
  error.value = null
  try {
    const info = await setLanAccess(next)
    enabled.value = info.lanEnabled
    lanUrl.value = info.lanUrl
    if (!info.lanEnabled) {
      code.value = null
      qrSvg.value = null
      error.value = info.lanUrl === null && next ? '没有找到局域网地址，请先连上 Wi-Fi' : null
      return
    }
    await requestCode()
  } catch (e) {
    enabled.value = false
    lanUrl.value = null
    code.value = null
    qrSvg.value = null
    error.value = e instanceof Error ? e.message : '切换失败'
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  ticker = setInterval(() => {
    now.value = Date.now()
  }, 1000)

  try {
    const info = await localServerInfo()
    if (info?.lanEnabled && info.lanUrl) {
      enabled.value = true
      lanUrl.value = info.lanUrl
      await requestCode()
    }
  } catch {
    /* 非一体版不会有这个命令，忽略 */
  }
})

// 配对码过期后自动续一个，避免用户对着二维码发愣
watch(remaining, (value) => {
  if (enabled.value && value === 0 && !busy.value) void requestCode()
})

onBeforeUnmount(() => {
  if (ticker) clearInterval(ticker)
})
</script>

<template>
  <div class="space-y-3">
    <SettingsCard
      id="mobile-access"
      title="手机接入"
      description="把本机服务端开放到局域网，手机扫码后直接连上这份数据"
      icon="smartphone"
    >
      <SettingRow
        label="允许手机接入"
        description="开启后服务端会监听局域网地址，关闭即恢复只允许本机访问"
        for-id="mobile-access-switch"
      >
        <Switch
          id="mobile-access-switch"
          :model-value="enabled"
          :disabled="busy"
          @update:model-value="toggle"
        />
      </SettingRow>

      <p v-if="error" class="mt-2 text-[11.5px] text-danger">{{ error }}</p>

      <div v-if="enabled && qrSvg" class="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center">
        <!-- 二维码必须保持深码浅底，深色主题下也只是外面套一层白卡 -->
        <div class="w-fit rounded-xl bg-white p-3 shadow-sm">
          <SvgIcon :source="qrSvg" class="block h-[168px] w-[168px]" label="手机接入二维码" />
        </div>

        <div class="min-w-0 flex-1 space-y-2 text-[12px] text-muted">
          <p class="text-text">
            用手机 NenoChat 扫描这个二维码，或用相机扫码打开链接。
          </p>
          <p class="text-[11px]">
            扫码没反应时，在手机登录页切到「配对码」手动输入下面这串字符。
          </p>
          <p class="break-all font-mono text-[11px] text-text">{{ lanUrl }}</p>
          <p>
            配对码
            <span class="ml-1 rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[12px] tracking-[0.18em] text-text-strong">
              {{ code }}
            </span>
            <span class="ml-2">{{ remaining }} 秒后失效</span>
          </p>
          <Button variant="ghost" size="sm" icon="refresh" :loading="busy" @click="requestCode">
            换一个配对码
          </Button>
        </div>
      </div>

      <p v-else-if="enabled && !error" class="mt-3 text-[11.5px] text-muted">正在生成二维码…</p>
    </SettingsCard>
  </div>
</template>
