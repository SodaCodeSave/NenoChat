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

  it('进页自动探测全部服务器，并可手动刷新重测', () => {
    expect(setupSource).toContain('void testServers()')
    expect(setupSource).toContain('@click="testServers"')
    expect(setupSource).toContain('await servers.probe(server.baseUrl)')
    expect(setupSource).toContain('Promise.all(')
  })

  it('选中服务器后清空旧会话并重置工作区', () => {
    expect(setupSource).toContain('await servers.setCurrent(id)')
    expect(setupSource).toContain('resetWorkspace()')
    expect(setupSource).toContain('await auth.clearSession()')
  })
})
