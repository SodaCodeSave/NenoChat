import { describe, expect, it } from 'vitest'
import setupSource from './SetupView.vue?raw'

describe('服务器双栏页', () => {
  it('宽屏左右双栏，窄屏上下堆叠', () => {
    expect(setupSource).toContain('grid gap-5 lg:grid-cols-2')
  })

  it('左侧选择服务器，右侧嵌入登录表单', () => {
    expect(setupSource).toContain('<LoginForm')
    expect(setupSource.indexOf('选择服务器')).toBeLessThan(setupSource.indexOf('<LoginForm'))
  })

  it('测试通过显示绿点，测试失败显示红点', () => {
    expect(setupSource).toContain("if (state === 'online') return 'bg-success'")
    expect(setupSource).toContain("if (state === 'offline') return 'bg-danger'")
    expect(setupSource).toContain(':class="dotClass(status[server.id])"')
  })

  it('每个服务器显示探测到的版本号', () => {
    expect(setupSource).toContain('const info = await servers.probe(server.baseUrl)')
    expect(setupSource).toContain('versions.value[server.id] = info.version')
    expect(setupSource).toContain('v-if="versions[server.id]"')
  })

  it('进页自动探测全部服务器，并可手动刷新重测', () => {
    expect(setupSource).toContain('await testServers()')
    expect(setupSource).toContain('@click="testServers"')
    expect(setupSource).toContain('await servers.probe(server.baseUrl)')
    expect(setupSource).toContain('Promise.all(')
  })

  it('选中服务器后清空旧会话并重置工作区', () => {
    expect(setupSource).toContain('await servers.setCurrent(id)')
    expect(setupSource).toContain('resetWorkspace()')
    expect(setupSource).toContain('await auth.clearSession()')
  })

  it('缺本地网络权限时给出授权与去设置入口', () => {
    expect(setupSource).toContain('需要「附近的设备」权限')
    expect(setupSource).toContain('@click="grantPermission"')
    expect(setupSource).toContain('@click="goToSettings"')
    expect(setupSource).toContain('requestLocalNetworkAccess')
    expect(setupSource).toContain('openLocalNetworkSettings')
  })

  it('进页探测不弹系统授权框，授权后才重测', () => {
    expect(setupSource).toContain('await refreshLocalNetwork()')
    expect(setupSource).toContain('if (localNetwork.value === \'granted\') await testServers()')
  })

  it('权限不足的服务器标为待授权而不是不可用', () => {
    expect(setupSource).toContain("e instanceof LocalNetworkPermissionError ? 'blocked' : 'offline'")
    expect(setupSource).toContain("if (state === 'blocked') return '需要本地网络权限'")
  })

  it('安装包缺少原生桥时提示更新客户端', () => {
    expect(setupSource).toContain('当前安装包缺少本地网络支持')
    expect(setupSource).toContain('!nativeBridgeAvailable()')
    expect(setupSource).toContain('v-else-if="permissionBlocked"')
  })
})

describe('手机端卡片翻转', () => {
  it('移动端两面互斥显示，桌面端同时渲染', () => {
    expect(setupSource).toContain(`v-show="!ui.isMobile || face === 'servers'"`)
    expect(setupSource).toContain(`v-show="!ui.isMobile || face === 'login'"`)
  })

  it('已有当前服务器时进页直接停在登录面', () => {
    expect(setupSource).toContain("ui.isMobile && servers.current !== null ? 'login' : 'servers'")
  })

  it('点击服务器或添加成功后翻转到登录面', () => {
    expect(setupSource).toContain('await auth.clearSession()\n    void flipTo(\'login\')')
    expect(setupSource).toContain("label.value = ''\n    void flipTo('login')")
  })

  it('已选中的服务器再点一次也直接翻到登录面', () => {
    expect(setupSource).toContain("if (id === servers.currentId) {\n    void flipTo('login')")
  })

  it('登录卡片提供切回服务器列表的入口', () => {
    expect(setupSource).toContain(':show-server-switch="ui.isMobile"')
    expect(setupSource).toContain(`@change-server="flipTo('servers')"`)
  })

  it('翻转期间禁止重复触发，同面切换直接跳过', () => {
    expect(setupSource).toContain('if (next === face.value || flipping.value) return')
  })

  it('非移动端或开启减少动效时直接换面不做动画', () => {
    expect(setupSource).toContain('if (!ui.isMobile || ui.reduceMotion)')
  })

  it('翻转分两段：转走换面再转回', () => {
    expect(setupSource).toContain("tilt.value = 'out'")
    expect(setupSource).toContain("tilt.value = 'in'")
    expect(setupSource).toContain('face.value = next')
    expect(setupSource).toContain('void document.body.offsetHeight')
  })

  it('翻转走 3D 透视与缩放过渡', () => {
    expect(setupSource).toContain('perspective(1200px) rotateY(90deg) scale(0.86)')
    expect(setupSource).toContain('perspective(1200px) rotateY(-90deg) scale(0.86)')
    expect(setupSource).toContain('transition: transform 200ms cubic-bezier(0.22, 1, 0.36, 1)')
  })

  it('跨过移动端断点时朝向对齐到当前状态', () => {
    expect(setupSource).toContain('watch(\n  () => ui.isMobile,')
    expect(setupSource).toContain("face.value = servers.current !== null ? 'login' : 'servers'")
  })
})
