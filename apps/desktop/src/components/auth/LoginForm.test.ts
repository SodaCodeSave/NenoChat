import { describe, expect, it } from 'vitest'
import formSource from '@/components/auth/LoginForm.vue?raw'
import loginSource from '@/views/LoginView.vue?raw'
import routerSource from '@/app/router.ts?raw'
import appSource from '@/App.vue?raw'
import bareSource from '@/layouts/BareLayout.vue?raw'

describe('登录入口', () => {
  it('登录表单在服务切换后重新绑定并重置', () => {
    expect(formSource).toContain("watch(() => servers.currentId")
    expect(formSource).toContain('auth.bindServer()')
    expect(formSource).toContain('readLastUser(servers.currentId)')
  })

  it('没有选中服务器时给出占位提示', () => {
    expect(formSource).toContain('请先选择或添加一个服务器')
  })

  it('独立登录页复用同一表单并保留切换入口', () => {
    expect(loginSource).toContain('LoginForm')
    expect(loginSource).toContain(':show-server-switch="true"')
  })

  it('未登录默认落到服务器页', () => {
    expect(routerSource).toContain("return { name: 'setup' }")
    expect(appSource).toContain("await router.replace('/setup')")
  })

  it('裸布局容器放宽以容纳双栏，独立登录页仍收窄', () => {
    expect(bareSource).toContain('max-w-5xl')
    expect(loginSource).toContain('max-w-md')
  })
})
