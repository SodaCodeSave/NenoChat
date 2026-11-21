<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { adminApi, type AdminSettings } from '@/api/admin'
import Button from '@/components/ui/form/Button.vue'
import TextInput from '@/components/ui/form/TextInput.vue'
import Segmented from '@/components/ui/form/Segmented.vue'
import Alert from '@/components/ui/form/Alert.vue'
import { formatTime } from '@/utils/format'

const settings = ref<AdminSettings | null>(null)
const loading = ref(true)
const saving = ref(false)
const errorMessage = ref('')
const notice = ref('')

const serverName = ref('')
const registrationMode = ref<string>('open')

async function load(): Promise<void> {
  loading.value = true
  try {
    const res = await adminApi.settings.get()
    settings.value = res
    serverName.value = res.serverName
    registrationMode.value = res.registrationMode
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : '加载失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)

async function save(): Promise<void> {
  if (!serverName.value.trim()) {
    errorMessage.value = '服务器名不能为空'
    return
  }
  saving.value = true
  errorMessage.value = ''
  notice.value = ''
  try {
    const res = await adminApi.settings.update({
      serverName: serverName.value.trim(),
      registrationMode: registrationMode.value,
    })
    notice.value = '设置已保存，立即生效'
    if (settings.value) {
      settings.value.serverName = res.serverName
      settings.value.registrationMode = res.registrationMode as AdminSettings['registrationMode']
    }
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    saving.value = false
  }
}

function modeDescription(mode: string): string {
  if (mode === 'open') return '任何人都能注册，自用小圈子的默认选择'
  if (mode === 'invite') return '新用户必须持有管理面板签发的邀请码'
  return '彻底关闭注册入口'
}
</script>

<template>
  <div>
    <h1 class="mb-4 text-[19px] font-semibold text-text-strong">服务器设置</h1>

    <div v-if="loading" class="space-y-3">
      <div v-for="i in 3" :key="i" class="h-24 animate-pulse rounded-xl border border-line bg-surface-2" />
    </div>

    <template v-else-if="settings">
      <div v-if="errorMessage" class="mb-3 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
        {{ errorMessage }}
      </div>
      <Alert v-if="notice" tone="success" class="mb-3">{{ notice }}</Alert>

      <section class="mb-3 rounded-xl border border-line bg-surface p-4">
        <h2 class="mb-3 text-[14px] font-semibold text-text-strong">基础信息</h2>
        <div class="space-y-3">
          <div>
            <label class="mb-1 block text-[12px] text-muted" for="server-name">服务器名称</label>
            <div class="flex items-center gap-2">
              <TextInput id="server-name" v-model="serverName" type="text" class="w-72" />
              <span v-if="settings.env.serverName !== serverName" class="text-[11px] text-muted">
                env 兜底值：{{ settings.env.serverName }}
              </span>
            </div>
            <p class="mt-1 text-[11px] text-muted">显示在客户端服务器列表与登录页，改完立即生效</p>
          </div>

          <div>
            <div class="mb-1 text-[12px] text-muted">注册模式</div>
            <Segmented
              v-model="registrationMode"
              aria-label="注册模式"
              :options="[
                { value: 'open', label: '开放注册' },
                { value: 'invite', label: '凭邀请码' },
                { value: 'closed', label: '关闭注册' },
              ]"
            />
            <p class="mt-1 text-[11px] text-muted">{{ modeDescription(registrationMode) }}</p>
          </div>

          <div>
            <Button variant="primary" size="sm" :loading="saving" @click="save">保存设置</Button>
          </div>
        </div>
      </section>

      <section class="rounded-xl border border-line bg-surface p-4">
        <h2 class="mb-3 text-[14px] font-semibold text-text-strong">服务器信息（只读）</h2>
        <dl class="grid grid-cols-2 gap-x-8 gap-y-2 text-[12.5px] lg:grid-cols-3">
          <div>
            <dt class="text-muted">版本</dt>
            <dd class="font-mono text-text">{{ settings.version }}</dd>
          </div>
          <div>
            <dt class="text-muted">构建时间</dt>
            <dd class="text-text">{{ formatTime(Date.parse(settings.buildStamp) || null) }}</dd>
          </div>
          <div>
            <dt class="text-muted">最低客户端版本</dt>
            <dd class="font-mono text-text">{{ settings.minClientVersion }}</dd>
          </div>
          <div>
            <dt class="text-muted">单图上传上限</dt>
            <dd class="text-text">{{ settings.maxUploadMb }} MB</dd>
          </div>
          <div>
            <dt class="text-muted">env 注册模式</dt>
            <dd class="text-text">{{ settings.env.registrationMode }}（面板未修改时使用）</dd>
          </div>
        </dl>
        <p class="mt-3 text-[11px] text-muted">
          上传上限等容量类配置仍由环境变量控制；面板可改的是名称与注册模式这两项运行时配置。
        </p>
      </section>
    </template>
  </div>
</template>
