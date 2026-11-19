import { describe, expect, it } from 'vitest'
import setupSource from './SetupView.vue?raw'

describe('服务器双栏页', () => {
  it('宽屏左右双栏，窄屏上下堆叠', () => {
    expect(setupSource).toContain('grid gap-5 lg:grid-cols-2')
  })

  it('左侧选择服务器，右侧嵌入登录表单', () => {
    expect(setupSource).toContain('<LoginForm />')
    expect(setupSource.indexOf('选择服务器')).toBeLessThan(setupSource.indexOf('<LoginForm />'))
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
})
