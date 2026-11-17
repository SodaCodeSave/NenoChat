import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useServersStore } from '@/stores/servers'

const routes: RouteRecordRaw[] = [
  {
    path: '/setup',
    name: 'setup',
    component: () => import('@/views/SetupView.vue'),
    meta: { layout: 'bare' },
  },
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
    meta: { layout: 'bare' },
  },
  {
    path: '/',
    name: 'home',
    component: () => import('@/views/HomeView.vue'),
    meta: { layout: 'main' },
  },
  {
    path: '/c/:conversationId',
    name: 'conversation',
    component: () => import('@/views/ConversationView.vue'),
    meta: { layout: 'main' },
  },
  {
    path: '/contacts',
    name: 'contacts',
    component: () => import('@/views/ContactsView.vue'),
    meta: { layout: 'main', section: 'contacts' },
  },
  {
    path: '/moments',
    name: 'moments',
    component: () => import('@/views/MomentsView.vue'),
    meta: { layout: 'main', section: 'moments' },
  },
  {
    path: '/settings/conversation/:conversationId',
    name: 'conversation-settings',
    component: () => import('@/views/ConversationSettingsView.vue'),
    meta: { layout: 'main', section: 'settings' },
  },
  {
    path: '/settings/:section?',
    name: 'settings',
    component: () => import('@/views/SettingsView.vue'),
    meta: { layout: 'main', section: 'settings' },
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

export const router = createRouter({
  // hash 模式在 Tauri 的自定义协议与静态托管下都不会出现刷新 404
  history: createWebHashHistory(),
  routes,
})

const publicRoutes = new Set(['login', 'setup'])

/**
 * 登录守卫：已登录不再停留在登录页，未登录也不允许直接进主界面。
 * 启动恢复期间放行，由 App.vue 在 bootstrap 结束后决定首屏。
 */
router.beforeEach((to) => {
  const auth = useAuthStore()
  if (auth.status === 'idle' || auth.status === 'restoring') return true

  const isPublic = publicRoutes.has(String(to.name))
  if (auth.isAuthenticated) return isPublic ? { name: 'home' } : true
  if (isPublic) return true

  const servers = useServersStore()
  return servers.current ? { name: 'login' } : { name: 'setup' }
})
