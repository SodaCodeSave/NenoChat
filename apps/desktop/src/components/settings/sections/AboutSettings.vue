<script setup lang="ts">
import { onMounted } from 'vue'
import SettingsCard from '@/components/ui/form/SettingsCard.vue'
import SettingRow from '@/components/ui/form/SettingRow.vue'
import { useServersStore, normalizeServerUrl } from '@/stores/servers'

const servers = useServersStore()

onMounted(() => {
  void servers.refreshInfo()
})
</script>

<template>
  <div class="space-y-3">
    <SettingsCard id="version" title="版本信息" icon="message">
      <SettingRow label="客户端版本">
        <span class="font-mono text-[12px] text-text">0.1.0</span>
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
  </div>
</template>
