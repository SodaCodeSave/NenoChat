import { describe, expect, it } from 'vitest'
import source from './ui.ts?raw'
import messageItemSource from '@/components/chat/MessageItem.vue?raw'
import appearanceSource from '@/components/settings/sections/AppearanceSettings.vue?raw'

describe('连接器提示开关', () => {
  it('ui store 提供本地持久化的 showConnectorHints 偏好，默认开启', () => {
    expect(source).toContain("const CONNECTOR_HINTS_KEY = 'nenochat.showConnectorHints'")
    // 未设置时默认显示（只有显式 'false' 才关闭）
    expect(source).toContain("localStorage.getItem(CONNECTOR_HINTS_KEY) !== 'false'")
    expect(source).toContain('setShowConnectorHints')
  })

  it('MessageItem 按偏好同时隐藏固化提示与实时提示', () => {
    expect(messageItemSource).toContain('!ui.showConnectorHints) return []')
    expect(messageItemSource).toContain('!ui.showConnectorHints) return ')
  })

  it('外观设置里提供连接器提示开关', () => {
    expect(appearanceSource).toContain('label="连接器提示"')
    expect(appearanceSource).toContain(':model-value="ui.showConnectorHints"')
    expect(appearanceSource).toContain('@update:model-value="ui.setShowConnectorHints"')
  })
})
