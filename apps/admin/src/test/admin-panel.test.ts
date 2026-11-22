import { describe, expect, it } from 'vitest'
import routerSource from '@/router.ts?raw'
import layoutSource from '@/layouts/AdminLayout.vue?raw'
import loginSource from '@/views/LoginView.vue?raw'
import usersSource from '@/views/UsersView.vue?raw'
import conversationsSource from '@/views/ConversationsView.vue?raw'
import postsSource from '@/views/PostsView.vue?raw'
import filesSource from '@/views/FilesView.vue?raw'
import authSource from '@/stores/auth.ts?raw'
import httpSource from '@/api/http.ts?raw'
import apiSource from '@/api/admin.ts?raw'
import aiConfigSource from '@/views/AiConfigView.vue?raw'

/**
 * 管理面板的结构断言：路由/导航/危险操作/登录校验这些关键行为
 * 用源码断言钉住，防止后续改动悄悄绕过守卫或漏掉确认弹窗。
 */

describe('管理面板结构', () => {
  it('使用 hash 路由（静态托管无 SPA fallback）', () => {
    expect(routerSource).toContain('createWebHashHistory()')
  })

  it('九个管理视图全部注册在主布局下，登录页独立', () => {
    const views = [
      'DashboardView',
      'UsersView',
      'InvitesView',
      'ConversationsView',
      'PostsView',
      'FilesView',
      'SettingsView',
      'AiUsageView',
      'AuditView',
    ]
    for (const view of views) {
      expect(routerSource, view).toContain(`@/views/${view}.vue`)
    }
    expect(routerSource).toContain("name: 'login'")
    expect(routerSource).toContain('meta: { public: true }')
  })

  it('路由守卫：未登录进管理页跳登录，非管理员同样拦截', () => {
    expect(routerSource).toContain('await auth.bootstrap()')
    expect(routerSource).toContain('if (!auth.authed) return { name: \'login\' }')
    expect(routerSource).toContain('if (!auth.isAdmin) return { name: \'login\' }')
  })

  it('侧栏导航十个入口齐全（含 AI 配置），含退出与主题切换', () => {
    for (const nav of [
      'dashboard',
      'users',
      'invites',
      'conversations',
      'posts',
      'files',
      'settings',
      'ai-config',
      'ai-usage',
      'audit',
    ]) {
      expect(layoutSource, nav).toContain(`name: '${nav}'`)
    }
    expect(layoutSource).toContain('退出登录')
    expect(layoutSource).toContain("toggleTheme")
  })

  it('登录后先校验 isAdmin，非管理员立即退出登录态', () => {
    expect(loginSource).toContain('auth.isAdmin')
    expect(loginSource).toContain('auth.dropSession()')
    expect(loginSource).toContain('该账号不是服务器管理员')
  })

  it('登录态：refresh token 持久化并处理服务端旋转，403 由守卫处理', () => {
    expect(authSource).toContain('REFRESH_KEY')
    expect(authSource).toContain('res.tokens.refreshToken')
    expect(authSource).toContain('dropSession')
  })

  it('设备标识不直接依赖 crypto.randomUUID（局域网明文 HTTP 无此 API）', () => {
    expect(authSource).toContain('getRandomValues')
    // 只允许「存在性检查后调用」的守卫形态，不允许裸调
    expect(authSource).toContain("typeof crypto.randomUUID === 'function'")
    expect(authSource).toContain('typeof crypto.getRandomValues')
  })

  it('HTTP 客户端 401 时静默刷新并重试一次', () => {
    expect(httpSource).toContain('refreshOnce()')
    expect(httpSource).toContain('_retried: true')
    expect(httpSource).toContain('onAuthLost()')
  })

  it('破坏性操作全部过确认弹窗', () => {
    expect(usersSource).toContain('<ConfirmDialog')
    expect(usersSource).toContain('永久删除')
    expect(usersSource).toContain('重置密码')
    expect(conversationsSource).toContain('recallTarget')
    expect(conversationsSource).toContain('<ConfirmDialog')
    expect(postsSource).toContain('<ConfirmDialog')
    expect(filesSource).toContain('<ConfirmDialog')
  })

  it('审计相关：删用户提示审计留痕，审计视图展示操作明细', () => {
    expect(usersSource).toContain('审计日志')
    expect(apiSource).toContain('/admin/audit')
  })

  it('API 包装覆盖全部服务端管理端点', () => {
    const endpoints = [
      '/admin/stats',
      '/admin/users',
      '/admin/invites',
      '/admin/conversations',
      '/admin/posts',
      '/admin/files',
      '/admin/settings',
      '/admin/ai/usage',
      '/admin/audit',
    ]
    for (const endpoint of endpoints) {
      expect(apiSource, endpoint).toContain(endpoint)
    }
  })

  it('AI 配置视图：统一 AI 开关/充值链接/供应商表单/AI 列表计费/余额充值齐全', () => {
    expect(aiConfigSource).toContain('统一 AI 服务')
    expect(aiConfigSource).toContain('toggleSharedMode')
    expect(aiConfigSource).toContain('setSharedMode')
    expect(aiConfigSource).toContain('setRechargeUrl')
    expect(aiConfigSource).toContain('充值链接')
    // 共享开启即禁用自定义供应商，界面不得再出现「共享」式回退话术
    expect(aiConfigSource).toContain('自定义供应商整体停用')
    expect(aiConfigSource).not.toContain('全服共享')
    expect(aiConfigSource).not.toContain('服务器共享')
    expect(aiConfigSource).toContain('AI 列表')
    expect(aiConfigSource).toContain('priceInput')
    expect(aiConfigSource).toContain('priceCached')
    expect(aiConfigSource).toContain('priceOutput')
    expect(aiConfigSource).toContain('元/百万 token')
    expect(aiConfigSource).toContain('testProviderStored')
    expect(aiConfigSource).toContain('importFormModels')
    expect(aiConfigSource).toContain('调整用户余额')
    expect(aiConfigSource).toContain('<ConfirmDialog')
    expect(aiConfigSource).toContain('matchProviderIcon')
    expect(aiConfigSource).toContain('AI_PROVIDER_PRESETS')
  })

  it('AI 配置端点覆盖 /admin/ai 家族', () => {
    const endpoints = [
      '/admin/ai/providers',
      '/admin/ai/shared-mode',
      '/admin/ai/providers/models',
      '/admin/ai/providers/test',
      '/admin/ai/balances',
    ]
    for (const endpoint of endpoints) {
      expect(apiSource, endpoint).toContain(endpoint)
    }
  })
})
