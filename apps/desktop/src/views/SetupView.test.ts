import { describe, expect, it } from 'vitest'
import setupSource from './SetupView.vue?raw'

describe('选服务器页', () => {
  it('页面收窄为单栏，与登录页一致', () => {
    expect(setupSource).toContain('mx-auto w-full max-w-md')
    expect(setupSource).not.toContain('lg:grid-cols-2')
  })

  it('不再内嵌登录表单，选完服务器跳转登录页', () => {
    expect(setupSource).not.toContain('<LoginForm')
    expect(setupSource).toContain("await router.replace('/login')")
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
    expect(setupSource).toContain("if (before !== 'granted' && localNetwork.value === 'granted') await testServers()")
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
