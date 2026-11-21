import { describe, expect, it } from 'vitest'
import source from './NotificationSettings.vue?raw'
import settingsViewSource from '../../views/SettingsView.vue?raw'

describe('NotificationSettings', () => {
  it('页面结构与其他设置分区一致：外壳标题 + SettingsCard + SettingRow', () => {
    // 通知分区不再自带小标题，统一走设置外壳的 19px 页标题
    expect(settingsViewSource).not.toContain('selfHeader')
    expect(source).not.toContain('<h2')
    expect(source).toContain("import SettingsCard from '@/components/ui/form/SettingsCard.vue'")
    expect(source).toContain("import SettingRow from '@/components/ui/form/SettingRow.vue'")
    // 不允许手搓卡片样式，一律用共享卡片组件
    expect(source).not.toContain('rounded-xl border border-line bg-surface')
  })

  it('反馈提示用共享 Alert，不再手写彩色文案', () => {
    expect(source).toContain("import Alert from '@/components/ui/form/Alert.vue'")
    expect(source).toContain('<Alert v-if="error" tone="danger">')
    expect(source).toContain('<Alert v-else-if="savedHint" tone="success">已保存</Alert>')
    expect(source).not.toContain('text-danger')
  })

  it('四张卡片：系统通知、提醒方式、默认提醒级别、免打扰', () => {
    expect(source).toContain('id="system"')
    expect(source).toContain('id="alerts"')
    expect(source).toContain('id="levels"')
    expect(source).toContain('id="dnd"')
    for (const icon of ['icon="bell"', 'icon="volume"', 'icon="at"', 'icon="moon"']) {
      expect(source).toContain(icon)
    }
  })

  it('开关与级别选择用共享 Switch / Segmented，不再用原生 checkbox', () => {
    expect(source).toContain("import Switch from '@/components/ui/form/Switch.vue'")
    expect(source).toContain("import Segmented from '@/components/ui/form/Segmented.vue'")
    expect(source).not.toContain('type="checkbox"')
    // 三档级别选择器复用同一份 options，私聊与群聊各一个
    expect(source).toContain('const levelOptions')
    expect(source.match(/<Segmented/g)).toHaveLength(2)
  })

  it('保留乐观保存：先改本地再请求，失败回滚并报错', () => {
    expect(source).toContain('const previous = { ...form.value }')
    expect(source).toContain('form.value = { ...form.value, ...partial }')
    expect(source).toContain('await auth.updateNotificationSettings(partial)')
    expect(source).toContain('form.value = previous')
    expect(source).toContain("error.value = e instanceof Error ? e.message : '保存失败'")
  })

  it('保留授权、测试通知与免打扰时段输入', () => {
    expect(source).toContain('@click="enableSystemNotification"')
    expect(source).toContain('await notifications.requestPermission()')
    expect(source).toContain('@click="sendTestNotification"')
    expect(source).toContain('await notifications.sendTest()')
    expect(source.match(/type="time"/g)).toHaveLength(2)
    expect(source).toContain('patch({ dndStart: ($event.target as HTMLInputElement).value })')
    expect(source).toContain('patch({ dndEnd: ($event.target as HTMLInputElement).value })')
    expect(source).toContain('时区：{{ form.timezone }}')
  })

  it('提示语定时器随组件卸载清理', () => {
    expect(source).toContain('onBeforeUnmount(() => {')
    expect(source).toContain('window.clearTimeout(savedTimer)')
    expect(source).toContain('window.clearTimeout(testTimer)')
  })
})
