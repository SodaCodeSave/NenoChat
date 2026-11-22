import { defineStore } from 'pinia'
import { authApi, type AdminUser } from '@/api/admin'
import { configureHttp, request, setAccessToken, ApiError } from '@/api/http'

/**
 * 管理面板登录态。
 * access token 只在内存里（15 分钟有效期，401 时静默刷新）；
 * refresh token 与设备标识持久化在 localStorage，页面刷新后能自动续期。
 */

const REFRESH_KEY = 'nenochat.admin.refreshToken'
const DEVICE_KEY = 'nenochat.admin.deviceId'

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* 隐私模式等场景下 localStorage 不可用，登录态退化为仅内存 */
  }
}

/** 生成一段本地唯一的设备标识；面板常走局域网明文 HTTP（非安全上下文），
 * crypto.randomUUID 只在安全上下文存在，必须带 getRandomValues 兜底 */
export function randomId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID().replace(/-/g, '')
    }
    const bytes = new Uint8Array(16)
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      crypto.getRandomValues(bytes)
    } else {
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
    }
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    // crypto 对象整个不可用的极端场景，唯一性够用就行
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
  }
}

function ensureDeviceId(): string {
  const existing = readStorage(DEVICE_KEY)
  if (existing) return existing
  const id = `admin-${randomId().slice(0, 20)}`
  writeStorage(DEVICE_KEY, id)
  return id
}

export const useAuthStore = defineStore('admin-auth', {
  state: () => ({
    user: null as AdminUser | null,
    booted: false,
    /** 启动恢复中或登录请求进行中 */
    loading: false,
  }),

  getters: {
    authed: (state) => state.user !== null,
    isAdmin: (state) => state.user?.isAdmin === true,
    displayName: (state) => state.user?.displayName ?? state.user?.username ?? '',
  },

  actions: {
    bindHttp() {
      configureHttp({
        refresh: async () => {
          const refreshToken = readStorage(REFRESH_KEY)
          if (!refreshToken) return null
          try {
            const res = await request<{ tokens: AuthTokensShape }>('/auth/refresh', {
              method: 'POST',
              body: { refreshToken, device: { id: ensureDeviceId() } },
              auth: false,
            })
            setAccessToken(res.tokens.accessToken)
            return res.tokens.accessToken
          } catch {
            return null
          }
        },
        onAuthLost: () => {
          this.dropSession()
        },
      })
    },

    /** 页面刷新后调用：有 refresh token 就静默续期并拉取当前用户 */
    async bootstrap(): Promise<void> {
      this.loading = true
      try {
        if (readStorage(REFRESH_KEY)) {
          const token = await this.refreshAccessToken()
          if (token) await this.fetchMe()
        }
      } finally {
        this.loading = false
        this.booted = true
      }
    },

    async refreshAccessToken(): Promise<string | null> {
      const refreshToken = readStorage(REFRESH_KEY)
      if (!refreshToken) return null
      try {
        const res = await request<{ tokens: { accessToken: string; refreshToken: string } }>(
          '/auth/refresh',
          { method: 'POST', body: { refreshToken, device: { id: ensureDeviceId() } }, auth: false },
        )
        setAccessToken(res.tokens.accessToken)
        // 服务端旋转 refresh token：旧令牌作废，必须存新的
        writeStorage(REFRESH_KEY, res.tokens.refreshToken)
        return res.tokens.accessToken
      } catch (e) {
        if (e instanceof ApiError && e.isAuthError) this.dropSession()
        return null
      }
    },

    async fetchMe(): Promise<void> {
      const res = await authApi.me()
      this.user = res.user
    },

    async login(username: string, password: string): Promise<void> {
      const res = await authApi.login({
        username,
        password,
        device: { id: ensureDeviceId(), name: '管理面板', platform: 'web' },
      })
      setAccessToken(res.tokens.accessToken)
      writeStorage(REFRESH_KEY, res.tokens.refreshToken)
      await this.fetchMe()
    },

    async logout(): Promise<void> {
      const refreshToken = readStorage(REFRESH_KEY)
      try {
        if (refreshToken) await authApi.logout(refreshToken)
      } catch {
        /* 服务端吊销失败也要把本地清干净 */
      }
      this.dropSession()
    },

    dropSession(): void {
      setAccessToken(null)
      writeStorage(REFRESH_KEY, null)
      this.user = null
    },
  },
})

interface AuthTokensShape {
  accessToken: string
  refreshToken: string
}
