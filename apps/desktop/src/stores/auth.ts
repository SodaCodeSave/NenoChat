import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { NotificationSettings, User, UserSettings } from '@nenochat/shared'
import { authApi, notificationSettingsApi, pairingApi } from '@/api/endpoints'
import { ApiError, configureHttp, setAccessToken } from '@/api/http'
import { deleteSecret, getSecret, setSecret } from '@/platform/secure-store'
import { deviceId, deviceName, platformName } from '@/platform/device'
import { localServerInfo } from '@/platform/local-server'
import { ensureLocalNetworkAccess } from '@/platform/local-network'
import { CLIENT_VERSION } from '@/version'
import { useServersStore } from './servers'

export type AuthStatus = 'idle' | 'restoring' | 'authenticated' | 'anonymous'
/** 自动登录恢复失败的原因：auth 表示凭证失效需重登，其余可重试 */
export type RestoreFailure = 'network' | 'server' | 'auth' | null

export interface LastUser {
  id: string
  username: string
  displayName: string
  avatarUrl: string | null
}

const refreshKey = (serverId: string): string => `refresh.${serverId}`
const lastUserKey = (serverId: string): string => `nenochat.lastUser.${serverId}`

/** 读取上次登录的用户，供登录页展示与用户名预填 */
export function readLastUser(serverId: string | null): LastUser | null {
  if (!serverId) return null
  try {
    const raw = localStorage.getItem(lastUserKey(serverId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<LastUser>
    if (!parsed.id || !parsed.username) return null
    return {
      id: parsed.id,
      username: parsed.username,
      displayName: parsed.displayName || parsed.username,
      avatarUrl: parsed.avatarUrl ?? null,
    }
  } catch {
    return null
  }
}

function saveLastUser(serverId: string, user: User): void {
  try {
    localStorage.setItem(
      lastUserKey(serverId),
      JSON.stringify({
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl ?? null,
      }),
    )
  } catch {
    /* 隐私模式下可能不可用 */
  }
}

/** 只有 401 说明凭证真的失效；网络错误和 5xx 都要保留凭证等待下次重试 */
function classifyFailure(e: unknown): Exclude<RestoreFailure, null> {
  if (e instanceof ApiError) return e.status === 401 ? 'auth' : 'server'
  return 'network'
}

/**
 * 登录态管理。
 * access token 只放内存（15 分钟过期由 http 层静默刷新），
 * refresh token 存系统钥匙串，按服务器隔离。
 */
export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null)
  const status = ref<AuthStatus>('idle')
  const settings = ref<UserSettings | null>(null)
  const notificationSettings = ref<NotificationSettings | null>(null)
  const accessToken = ref<string | null>(null)
  const error = ref<string | null>(null)
  /** 自动登录恢复失败时的提示，供登录页展示与重试 */
  const restoreError = ref<string | null>(null)
  const restoreFailure = ref<RestoreFailure>(null)
  const hasStoredCredential = ref(false)

  let refreshToken = ''
  let refreshInFlight: Promise<string | null> | null = null
  let lastFailure: RestoreFailure = null

  const isAuthenticated = computed(() => status.value === 'authenticated' && user.value !== null)
  const currentServerId = computed(() => useServersStore().currentId)

  const devicePayload = () => ({
    id: deviceId(),
    name: deviceName(),
    platform: platformName(),
    appVersion: CLIENT_VERSION,
  })

  function bindServer(): void {
    const servers = useServersStore()
    configureHttp({
      baseUrl: servers.current?.baseUrl ?? '',
      deviceId: deviceId(),
      refresh: () => refreshSession(),
      onAuthLost: () => {
        // 网络或服务端故障不代表凭证失效，保留下来下次启动才能继续自动登录
        if (lastFailure === 'network' || lastFailure === 'server') return
        void clearSession()
      },
    })
  }

  async function applySession(payload: {
    user: User
    tokens: { accessToken: string; refreshToken: string }
  }): Promise<void> {
    const serverId = currentServerId.value
    user.value = payload.user
    accessToken.value = payload.tokens.accessToken
    refreshToken = payload.tokens.refreshToken
    setAccessToken(payload.tokens.accessToken)
    status.value = 'authenticated'
    lastFailure = null

    if (serverId) {
      try {
        await setSecret(refreshKey(serverId), refreshToken)
        hasStoredCredential.value = true
      } catch (e) {
        // 钥匙串不可用（如移动端）时本次登录仍然有效，只是下次需要重新输入密码
        hasStoredCredential.value = false
        console.error('[auth] 无法保存自动登录凭证', e)
      }
      await useServersStore().rememberUser(serverId, payload.user.id)
      saveLastUser(serverId, payload.user)
    }
  }

  /** 连局域网服务器前确认本地网络权限，缺权限时顺手弹一次系统授权框 */
  async function ensureServerAccess(): Promise<void> {
    const server = useServersStore().current
    if (!server) return
    await ensureLocalNetworkAccess(server.baseUrl, { interactive: true })
  }

  async function login(username: string, password: string): Promise<void> {
    error.value = null
    try {
      await ensureServerAccess()
    } catch (e) {
      error.value = e instanceof Error ? e.message : '登录失败'
      throw e
    }
    bindServer()
    try {
      const result = await authApi.login({ username, password, device: devicePayload() })
      await applySession(result)
      await loadProfile()
    } catch (e) {
      error.value = e instanceof Error ? e.message : '登录失败'
      throw e
    }
  }

  async function register(input: {
    username: string
    password: string
    displayName: string
    inviteCode?: string
  }): Promise<void> {
    error.value = null
    try {
      await ensureServerAccess()
    } catch (e) {
      error.value = e instanceof Error ? e.message : '注册失败'
      throw e
    }
    bindServer()
    try {
      const result = await authApi.register({ ...input, device: devicePayload() })
      await applySession(result)
      await loadProfile()
    } catch (e) {
      error.value = e instanceof Error ? e.message : '注册失败'
      throw e
    }
  }

  /** 一体化版免密登录：拿客户端进程注入的握手令牌直接换会话 */
  async function loginLocal(): Promise<void> {
    error.value = null
    const local = await localServerInfo()
    if (!local) throw new Error('未找到内置服务端')
    bindServer()
    try {
      const result = await authApi.local({ device: devicePayload() }, local.token)
      await applySession(result)
      await loadProfile()
    } catch (e) {
      error.value = e instanceof Error ? e.message : '登录失败'
      throw e
    }
  }

  /** 手机扫码接入：用电脑生成的配对码换一份会话 */
  async function pairWithCode(code: string): Promise<void> {
    error.value = null
    bindServer()
    try {
      const result = await pairingApi.pair({ code, device: devicePayload() })
      await applySession(result)
      await loadProfile()
    } catch (e) {
      error.value = e instanceof Error ? e.message : '配对失败'
      throw e
    }
  }

  async function loadProfile(): Promise<void> {
    const me = await authApi.me()
    if (me.user) user.value = me.user
    if (me.settings) settings.value = me.settings
    if (me.notificationSettings) notificationSettings.value = me.notificationSettings
  }

  /** 通知设置沿用服务端既有设置表，保存后回填本地，供通知判定即时使用 */
  async function updateNotificationSettings(
    patch: Partial<NotificationSettings>,
  ): Promise<NotificationSettings> {
    const result = await notificationSettingsApi.update(patch)
    notificationSettings.value = result.notificationSettings
    return result.notificationSettings
  }

  /** 用 refresh token 换新的 access token；并发调用共享同一次请求 */
  async function refreshSession(): Promise<string | null> {
    if (refreshInFlight) return refreshInFlight
    const serverId = currentServerId.value
    if (!serverId) return null

    refreshInFlight = (async () => {
      try {
        if (!refreshToken) refreshToken = await getSecret(refreshKey(serverId))
        if (!refreshToken) {
          lastFailure = 'auth'
          restoreFailure.value = 'auth'
          restoreError.value = '登录状态已失效，请重新登录'
          return null
        }

        const result = await authApi.refresh(refreshToken, deviceId())
        await applySession(result)
        lastFailure = null
        restoreFailure.value = null
        restoreError.value = null
        return result.tokens.accessToken
      } catch (e) {
        const failure = classifyFailure(e)
        // 只有确认凭证失效才删除钥匙串记录；断网或服务端故障保留凭证
        if (failure === 'auth') await clearSession()
        // clearSession 会重置失败标记，这里补回本次失败原因
        lastFailure = failure
        restoreFailure.value = failure
        restoreError.value =
          failure === 'auth'
            ? '登录状态已失效，请重新登录'
            : failure === 'network'
              ? '无法连接服务器，请检查网络后重试'
              : e instanceof Error
                ? e.message
                : '恢复登录状态失败'
        return null
      } finally {
        refreshInFlight = null
      }
    })()

    return refreshInFlight
  }

  /**
   * 一体化版启动：优先复用钥匙串里的 refresh token，
   * 内置服务端重建过数据库或令牌失效时，退回本机握手令牌重新换会话。
   */
  async function bootstrapLocal(serverId: string): Promise<boolean> {
    status.value = 'restoring'
    restoreError.value = null
    restoreFailure.value = null
    lastFailure = null

    refreshToken = await getSecret(refreshKey(serverId))
    hasStoredCredential.value = Boolean(refreshToken)
    if (refreshToken && (await refreshSession())) {
      try {
        await loadProfile()
      } catch {
        // refresh 响应已带用户信息，档案接口抖动不影响进首页
      }
      return true
    }

    try {
      await loginLocal()
      return true
    } catch (e) {
      status.value = 'anonymous'
      restoreFailure.value = 'server'
      restoreError.value = e instanceof Error ? e.message : '内置服务端启动失败'
      return false
    }
  }

  /** 启动时恢复登录态：有 refresh token 就静默续期，否则等用户手动登录 */
  async function bootstrap(): Promise<boolean> {
    bindServer()
    const serverId = currentServerId.value
    if (!serverId) {
      status.value = 'anonymous'
      return false
    }

    if (useServersStore().integrated) return bootstrapLocal(serverId)

    status.value = 'restoring'
    restoreError.value = null
    restoreFailure.value = null
    lastFailure = null
    refreshToken = await getSecret(refreshKey(serverId))
    hasStoredCredential.value = Boolean(refreshToken)
    if (!refreshToken) {
      status.value = 'anonymous'
      return false
    }

    const token = await refreshSession()
    if (!token) {
      status.value = 'anonymous'
      return false
    }

    try {
      await loadProfile()
    } catch {
      // 档案接口失败多为网络抖动，refresh 响应已带用户信息，不阻断自动登录
    }
    return true
  }

  async function clearSession(): Promise<void> {
    const serverId = currentServerId.value
    user.value = null
    accessToken.value = null
    refreshToken = ''
    settings.value = null
    notificationSettings.value = null
    setAccessToken(null)
    status.value = 'anonymous'
    hasStoredCredential.value = false
    restoreError.value = null
    restoreFailure.value = null
    lastFailure = null
    if (serverId) await deleteSecret(refreshKey(serverId))
  }

  async function logout(): Promise<void> {
    try {
      await authApi.logout(refreshToken)
    } catch {
      /* 网络不可用时也要清本地凭证 */
    }
    await clearSession()
  }

  return {
    user,
    status,
    settings,
    notificationSettings,
    accessToken,
    error,
    restoreError,
    restoreFailure,
    hasStoredCredential,
    isAuthenticated,
    bindServer,
    login,
    loginLocal,
    pairWithCode,
    register,
    registerDevice: devicePayload,
    loadProfile,
    updateNotificationSettings,
    refreshSession,
    bootstrap,
    clearSession,
    logout,
    devicePayload,
  }
})
