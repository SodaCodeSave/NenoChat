import { describe, expect, it } from 'vitest'
import formSource from '@/components/auth/LoginForm.vue?raw'
import loginSource from '@/views/LoginView.vue?raw'
import routerSource from '@/app/router.ts?raw'
import appSource from '@/App.vue?raw'
import bareSource from '@/layouts/BareLayout.vue?raw'
import authSource from '@/stores/auth.ts?raw'
import secureStoreSource from '@/platform/secure-store.ts?raw'

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

describe('登录页极简化', () => {
  it('去掉外层卡片容器', () => {
    expect(formSource).not.toContain('rounded-2xl border border-line bg-surface p-6')
    expect(formSource).not.toContain('shadow-[var(--shadow-soft)]')
  })

  it('去掉上次登录用户卡片与底部说明', () => {
    expect(formSource).not.toContain('上次登录')
    expect(formSource).not.toContain('凭据保存在本机钥匙串')
    expect(formSource).not.toContain('Avatar')
  })

  it('logo、标题与服务器切换居中展示', () => {
    expect(formSource).toContain('flex-col items-center')
    expect(formSource).toContain('text-center')
  })
})

describe('保存密码与静默重登', () => {
  it('登录与注册成功后保存账号密码', () => {
    expect(authSource).toContain('applySession(result, { username, password })')
    expect(authSource).toContain('applySession(result, { username: input.username, password: input.password })')
    expect(authSource).toContain('setSecret(passwordKey(serverId)')
  })

  it('token 缺失或失效时用保存的密码静默重登', () => {
    expect(authSource).toContain('reloginWithStoredPassword')
    expect(authSource).toContain('if (await reloginWithStoredPassword()) return true')
  })

  it('静默重登确认凭证无效才删除保存的密码', () => {
    expect(authSource).toContain("if (failure === 'auth') await deleteSecret(passwordKey(serverId))")
  })

  it('主动登出时清除保存的密码', () => {
    expect(authSource).toContain('await deleteSecret(passwordKey(serverId))')
    expect(authSource).toContain('主动登出意味着不再自动登录')
  })

  it('钥匙串不可用的平台降级到本地存储', () => {
    expect(secureStoreSource).toContain('localStorage.setItem(prefix + key, value)')
    expect(secureStoreSource).toContain('降级到本地存储')
  })
})
