import { describe, expect, it } from 'vitest'
import appSource from './App.vue?raw'

describe('应用启动过渡', () => {
  it('加载页与主界面之间使用出入依次进行的淡入淡出', () => {
    expect(appSource).toContain('name="boot-fade"')
    expect(appSource).toContain('mode="out-in"')
    expect(appSource).toContain('<LoadingScreen v-if="!ready"')
  })

  it('加载页不再复用带标题栏与状态文案的外壳', () => {
    expect(appSource).not.toContain('stageLabel')
    expect(appSource).not.toContain('<BareLayout v-if="!ready">')
  })
})
