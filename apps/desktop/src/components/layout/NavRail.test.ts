import { describe, expect, it } from 'vitest'
import navRail from './NavRail.vue?raw'
import titleBar from './TitleBar.vue?raw'
import icon from '@/components/ui/Icon.vue?raw'
import appearance from '@/components/settings/sections/AppearanceSettings.vue?raw'
import uiStore from '@/stores/ui?raw'
import { iconFilledPaths } from '@/components/ui/icons'

describe('导航栏菜单文字开关', () => {
  it('文字受设置项控制，关掉后不再渲染', () => {
    expect(navRail).toContain('v-if="ui.showNavLabels" class="mt-0.5 text-[10px] leading-none"')
  })

  it('栏宽随文字开关在 64 与 56 之间切换，且带宽度过渡', () => {
    expect(navRail).toContain(":class=\"ui.showNavLabels ? 'w-[64px]' : 'w-[56px]'\"")
    expect(navRail).toContain('transition-[width]')
    // 顶栏品牌区与导航栏同宽，收窄后不能留缝
    expect(titleBar).toContain(":class=\"ui.showNavLabels ? 'w-16' : 'w-14'\"")
  })

  it('菜单按钮宽高固定，隐藏文字时图标仍然居中', () => {
    expect(navRail).toContain('flex h-11 w-11 flex-col items-center justify-center')
    expect(navRail).not.toContain('h-11 w-full')
  })

  it('设置项写进 UI store 并持久化到 localStorage', () => {
    expect(uiStore).toContain("const NAV_LABELS_KEY = 'nenochat.showNavLabels'")
    expect(uiStore).toContain("localStorage.getItem(NAV_LABELS_KEY) !== 'false'")
    expect(uiStore).toContain('function setShowNavLabels(next: boolean): void')
    expect(uiStore).toContain('localStorage.setItem(NAV_LABELS_KEY, String(next))')
  })

  it('外观设置里有一个「显示菜单文字」开关', () => {
    expect(appearance).toContain('label="显示菜单文字"')
    expect(appearance).toContain(':model-value="ui.showNavLabels"')
    expect(appearance).toContain('@update:model-value="ui.setShowNavLabels"')
  })
})

describe('导航栏选中态', () => {
  it('不再用投影抬升选中项，改成灰色填充底', () => {
    expect(navRail).not.toContain('shadow-sm')
    expect(navRail).toContain("'bg-rail-selected text-accent'")
  })

  it('选中时切实心图标，未选中保持线性', () => {
    expect(navRail).toContain(':filled="activeKey === item.key"')
    expect(icon).toContain('iconFilledPaths[props.name]')
    expect(icon).toContain(":fill=\"filledPath ? 'currentColor' : 'none'\"")
  })

  it('设置页把选中态给底部设置按钮，而不是顶部的消息', () => {
    expect(navRail).toContain("if (route.path.startsWith('/settings')) return 'settings'")
    expect(navRail).toContain(":filled=\"activeKey === 'settings'\"")
    expect(navRail).toContain("activeKey === 'settings'")
    expect(iconFilledPaths.settings, 'settings').toBeTruthy()
  })

  it('三个菜单图标都备了可填充的闭合路径', () => {
    for (const name of ['message', 'users', 'compass'] as const) {
      const filled = iconFilledPaths[name]
      expect(filled, name).toBeTruthy()
      expect(filled, name).toContain('Z')
    }
  })
})
