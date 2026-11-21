import { describe, expect, it } from 'vitest'
import source from './AppearanceSettings.vue?raw'

describe('AppearanceSettings 聊天背景', () => {
  it('模板里渲染隐藏的文件选择框，上传按钮才能唤起选择器', () => {
    // 回归：pick() 走 input.value?.click()，漏渲染 input 时点击会静默无反应
    expect(source).toContain('<input ref="input" type="file" accept="image/*"')
    expect(source).toContain('@change="onChange"')
  })

  it('上传走 kind=background，并在本地提取主色后随设置同步', () => {
    expect(source).toContain("kind: 'background'")
    expect(source).toContain('extractDominantColor(file)')
    expect(source).toContain('settingsApi.update({ chatBgUrl: attachment.url, chatBgAccent: accent })')
    expect(source).toContain('ui.setChatBackground(settings.chatBgUrl, settings.chatBgAccent)')
  })

  it('移除背景把 URL 与主色一并置空', () => {
    expect(source).toContain('settingsApi.update({ chatBgUrl: null, chatBgAccent: null })')
    expect(source).toContain('ui.setChatBackground(null, null)')
  })
})
