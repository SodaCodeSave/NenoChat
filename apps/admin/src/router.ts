import { createRouter, createWebHashHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

/**
 * hash 路由：静态托管下刷新 / 深链接都不需要服务端 SPA fallback。
 */
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { public: true },
    },
    {
      path: '/',
      component: () => import('@/layouts/AdminLayout.vue'),
      children: [
        { path: '', name: 'dashboard', component: () => import('@/views/DashboardView.vue') },
        { path: 'users', name: 'users', component: () => import('@/views/UsersView.vue') },
        { path: 'invites', name: 'invites', component: () => import('@/views/InvitesView.vue') },
        {
          path: 'conversations',
          name: 'conversations',
          component: () => import('@/views/ConversationsView.vue'),
        },
        { path: 'posts', name: 'posts', component: () => import('@/views/PostsView.vue') },
        { path: 'files', name: 'files', component: () => import('@/views/FilesView.vue') },
        { path: 'settings', name: 'settings', component: () => import('@/views/SettingsView.vue') },
        { path: 'ai-config', name: 'ai-config', component: () => import('@/views/AiConfigView.vue') },
        { path: 'ai-usage', name: 'ai-usage', component: () => import('@/views/AiUsageView.vue') },
        { path: 'audit', name: 'audit', component: () => import('@/views/AuditView.vue') },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()
  if (!auth.booted) {
    // 首次导航前完成会话恢复，避免闪登录页
    await auth.bootstrap()
  }
  if (to.meta.public) {
    if (to.name === 'login' && auth.isAdmin) return { name: 'dashboard' }
    return true
  }
  if (!auth.authed) return { name: 'login' }
  // 已登录但不是管理员：留在登录页给提示（守卫拒绝所有管理接口）
  if (!auth.isAdmin) return { name: 'login' }
  return true
})

export default router
