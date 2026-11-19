<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import BrandLogo from '@/components/layout/BrandLogo.vue'
import SettingsCard from '@/components/ui/form/SettingsCard.vue'
import SettingRow from '@/components/ui/form/SettingRow.vue'
import { useServersStore, normalizeServerUrl } from '@/stores/servers'
import { isTauri, platformName } from '@/platform/device'
import {
  nativeBridgeAvailable,
  nativeDiagnostics,
  webviewChromiumVersion,
  type NativeDiagnostics,
} from '@/platform/local-network'
import { CLIENT_VERSION } from '@/version'

const servers = useServersStore()
const diagnostics = ref<NativeDiagnostics | null>(null)

/** Android App 里理应有原生桥，缺了说明安装包没带上原生定制 */
const bridgeMissing = computed(
  () => isTauri() && platformName() === 'android' && !nativeBridgeAvailable(),
)

const runtimeLabel = computed(() => `${platformName()} · ${isTauri() ? '客户端' : '浏览器'}`)

const webviewLabel = computed(() => {
  const version = diagnostics.value?.webviewVersion
  if (version) {
    const name = diagnostics.value?.webviewPackage || 'WebView'
    return `${name} ${version}`
  }
  const chromium = webviewChromiumVersion()
  return chromium ? `Chromium ${chromium}` : '-'
})

const permissionLabel = computed(() => {
  if (bridgeMissing.value) return '缺少原生桥'
  if (!diagnostics.value) return platformName() === 'android' ? '未知' : '系统不需要'
  switch (diagnostics.value.status) {
    case 'granted':
      return '已授权'
    case 'denied':
      return '已拒绝'
    case 'prompt':
      return '未授权'
    default:
      return '系统不需要'
  }
})

const permissionTone = computed(() =>
  permissionLabel.value === '已授权' ? 'text-success' : bridgeMissing.value ? 'text-danger' : 'text-muted',
)

const permissionHint = computed(() => {
  if (bridgeMissing.value) return '安装包未包含原生定制，局域网访问会被系统静默拦截，请更新客户端'
  if (diagnostics.value?.permissionDeclared === false) return '当前安装包未声明 ACCESS_LOCAL_NETWORK'
  return ''
})

onMounted(() => {
  diagnostics.value = nativeDiagnostics()
  void servers.refreshInfo()
})
</script>

<template>
  <div class="space-y-3">
    <div class="about-hero">
      <div class="about-hero__glow about-hero__glow--a" aria-hidden="true" />
      <div class="about-hero__glow about-hero__glow--b" aria-hidden="true" />
      <div class="about-hero__glow about-hero__glow--c" aria-hidden="true" />
      <BrandLogo class="about-hero__logo" />
    </div>

    <SettingsCard id="version" title="版本信息" icon="message">
      <SettingRow label="客户端版本">
        <span class="font-mono text-[12px] text-text">{{ CLIENT_VERSION }}</span>
      </SettingRow>
      <SettingRow label="服务端版本">
        <span class="font-mono text-[12px] text-text">{{ servers.serverInfo?.version ?? '-' }}</span>
      </SettingRow>
      <SettingRow label="协议前缀">
        <span class="max-w-[240px] truncate font-mono text-[11.5px] text-muted">
          {{ normalizeServerUrl(servers.current?.baseUrl ?? 'http://localhost').baseUrl }}
        </span>
      </SettingRow>
    </SettingsCard>

    <SettingsCard id="storage-mode" title="数据模式" icon="folder">
      <SettingRow
        label="本地优先"
        description="消息、图片与文件先写入 SQLite 本地镜像，断网也能查看历史"
      >
        <span class="text-[12px] text-muted">SQLite 镜像</span>
      </SettingRow>
    </SettingsCard>

    <SettingsCard
      id="diagnostics"
      title="环境诊断"
      description="局域网服务器连不上时先看这里"
      icon="globe"
    >
      <SettingRow label="运行环境">
        <span class="font-mono text-[12px] text-text">{{ runtimeLabel }}</span>
      </SettingRow>
      <SettingRow v-if="diagnostics" label="Android 版本">
        <span class="font-mono text-[12px] text-text">
          {{ diagnostics.release }}（API {{ diagnostics.sdk }}）
        </span>
      </SettingRow>
      <SettingRow v-if="diagnostics" label="设备型号">
        <span class="max-w-[240px] truncate font-mono text-[11.5px] text-muted">
          {{ diagnostics.model }}
        </span>
      </SettingRow>
      <SettingRow label="WebView">
        <span class="max-w-[240px] truncate font-mono text-[11.5px] text-muted">
          {{ webviewLabel }}
        </span>
      </SettingRow>
      <SettingRow label="本地网络权限" :description="permissionHint">
        <span class="text-[12px]" :class="permissionTone">{{ permissionLabel }}</span>
      </SettingRow>
    </SettingsCard>
  </div>
</template>

<style scoped>
.about-hero {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 150px;
  border-radius: 14px;
  background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 24%, #0d0d1a), #14141f 72%);
}

.about-hero__glow {
  position: absolute;
  z-index: -1;
  border-radius: 50%;
  filter: blur(44px);
  opacity: 0.5;
  pointer-events: none;
}

.about-hero__glow--a {
  width: 210px;
  height: 210px;
  background: var(--accent);
  top: -95px;
  left: -30px;
  animation: about-drift-a 9s ease-in-out infinite;
}

.about-hero__glow--b {
  width: 180px;
  height: 180px;
  background: #7c5cff;
  bottom: -95px;
  right: 20px;
  animation: about-drift-b 11s ease-in-out infinite;
}

.about-hero__glow--c {
  width: 140px;
  height: 140px;
  background: #db2f85;
  top: 20px;
  right: 90px;
  opacity: 0.35;
  animation: about-drift-a 13s ease-in-out infinite reverse;
}

.about-hero__logo {
  position: relative;
  z-index: 1;
  height: 30px;
  color: #fff;
  filter: drop-shadow(0 2px 12px rgb(0 0 0 / 0.35));
}

@keyframes about-drift-a {
  0%,
  100% {
    transform: translate(0, 0) scale(1);
  }
  50% {
    transform: translate(22px, 16px) scale(1.12);
  }
}

@keyframes about-drift-b {
  0%,
  100% {
    transform: translate(0, 0) scale(1);
  }
  50% {
    transform: translate(-26px, -12px) scale(1.08);
  }
}
</style>
