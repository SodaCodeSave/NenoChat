import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { API_PREFIX, type ServerInfo, type ServerInstance } from '@nenochat/shared'
import { listServers, removeServerCascade, touchServer, upsertServer } from '@/db/dao/servers'
import { hasLocalDb } from '@/platform/db'
import { clearAttachmentCache } from '@/platform/file-cache'
import { localServerInfo, type LocalServerInfo } from '@/platform/local-server'
import { ensureLocalNetworkAccess } from '@/platform/local-network'

const CURRENT_KEY = 'nenochat.currentServer'
const SERVERS_KEY = 'nenochat.servers'

/** 一体化版只有这一个「服务器」，就是进程内拉起来的本地服务端 */
export const LOCAL_SERVER_ID = 'srv-local'

export interface NormalizedServer {
  baseUrl: string
  wsUrl: string
}

/** 把内置服务端包装成和远端服务器同构的实例，下游列表/切换逻辑无需分叉 */
export function localServerInstance(local: LocalServerInfo): ServerInstance {
  const now = Date.now()
  return {
    id: LOCAL_SERVER_ID,
    name: '本机数据',
    baseUrl: local.baseUrl,
    wsUrl: local.wsUrl,
    serverName: 'NenoChat 一体版',
    iconUrl: null,
    lastUserId: null,
    lastConnectedAt: now,
    addedAt: now,
  }
}

/** 接受 http(s):// 或无协议前缀的地址，输出 REST 与 WS 两个端点 */
export function normalizeServerUrl(raw: string): NormalizedServer {
  const trimmed = raw.trim().replace(/\/+$/, '')
  const withScheme = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`
  const url = new URL(withScheme)
  const secure = url.protocol === 'https:'
  return {
    baseUrl: `${url.protocol}//${url.host}`,
    wsUrl: `${secure ? 'wss' : 'ws'}://${url.host}/ws`,
  }
}

/**
 * 服务器实例管理：添加时可探测 /server/info 确认地址可用，
 * 切换服务器会清空内存态并重连，本地数据按 server_id 隔离不会串台。
 */
export const useServersStore = defineStore('servers', () => {
  const servers = ref<ServerInstance[]>([])
  const currentId = ref<string | null>(localStorage.getItem(CURRENT_KEY))
  const serverInfo = ref<ServerInfo | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  /** 一体化版标记：为 true 时不展示服务器管理，也不读写多服务器列表 */
  const integrated = ref(false)
  const localToken = ref<string | null>(null)

  const current = computed(() => servers.value.find((s) => s.id === currentId.value) ?? null)
  const hasServer = computed(() => current.value !== null)

  async function hydrate(): Promise<void> {
    try {
      const local = await localServerInfo()
      if (local) {
        // 内置服务端地址每次启动都会变（随机端口），必须用进程给的新地址覆盖
        integrated.value = true
        localToken.value = local.token
        servers.value = [localServerInstance(local)]
        currentId.value = LOCAL_SERVER_ID
        return
      }
    } catch (e) {
      // 一体化包里服务端起不来属于致命错误，标记模式后交给启动流程报错
      integrated.value = true
      throw e
    }

    if (hasLocalDb()) {
      servers.value = await listServers()
    } else {
      // 浏览器模式没有本地库，服务器列表退化为 localStorage
      try {
        const raw = localStorage.getItem(SERVERS_KEY)
        servers.value = raw ? (JSON.parse(raw) as ServerInstance[]) : []
      } catch {
        servers.value = []
      }
    }
    if (!currentId.value && servers.value.length > 0) {
      currentId.value = servers.value[0]!.id
    }
  }

  /** 把服务器列表落到本地（桌面走 SQLite，浏览器走 localStorage） */
  async function persist(): Promise<void> {
    if (!hasLocalDb()) {
      try {
        localStorage.setItem(SERVERS_KEY, JSON.stringify(servers.value))
      } catch {
        /* 隐私模式下可能不可用 */
      }
    }
  }

  /**
   * 探测地址是否是可用的 NenoChat 服务端。
   * 目标是局域网地址时先确认本地网络权限，interactive 决定缺权限时是否弹系统框。
   */
  async function probe(rawUrl: string, options: { interactive?: boolean } = {}): Promise<ServerInfo> {
    const { baseUrl } = normalizeServerUrl(rawUrl)
    await ensureLocalNetworkAccess(baseUrl, { interactive: options.interactive })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    try {
      const response = await fetch(`${baseUrl}${API_PREFIX}/server/info`, { signal: controller.signal })
      if (!response.ok) throw new Error(`服务器返回 ${response.status}`)
      return (await response.json()) as ServerInfo
    } finally {
      clearTimeout(timer)
    }
  }

  async function add(rawUrl: string, displayName?: string): Promise<ServerInstance> {
    if (integrated.value) throw new Error('一体版已内置服务端，无需添加')
    loading.value = true
    error.value = null
    try {
      const info = await probe(rawUrl, { interactive: true })
      const { baseUrl, wsUrl } = normalizeServerUrl(rawUrl)
      const existing = servers.value.find((s) => s.baseUrl === baseUrl)
      if (existing) {
        await upsertServer({ ...existing, serverName: info.name }, info.registration.inviteRequired ? 'invite' : 'open')
        await hydrate()
        return existing
      }

      const instance: ServerInstance = {
        id: `srv-${Math.random().toString(36).slice(2, 10)}`,
        name: displayName?.trim() || info.name,
        baseUrl,
        wsUrl,
        serverName: info.name,
        iconUrl: null,
        lastUserId: null,
        lastConnectedAt: Date.now(),
        addedAt: Date.now(),
      }
      await upsertServer(instance, info.registration.inviteRequired ? 'invite' : 'open')
      servers.value = [...servers.value.filter((s) => s.id !== instance.id), instance]
      await persist()
      return instance
    } catch (e) {
      error.value = e instanceof Error ? e.message : '无法连接到服务器'
      throw e
    } finally {
      loading.value = false
    }
  }

  async function setCurrent(id: string): Promise<void> {
    // 一体化版只有一个内置服务端，切换请求直接忽略
    if (integrated.value) return
    currentId.value = id
    localStorage.setItem(CURRENT_KEY, id)
    serverInfo.value = null
    await refreshInfo()
  }

  async function refreshInfo(): Promise<void> {
    if (!current.value) return
    try {
      serverInfo.value = await probe(current.value.baseUrl)
    } catch {
      serverInfo.value = null
    }
  }

  async function rename(id: string, name: string): Promise<void> {
    if (integrated.value) return
    await touchServer(id, { name })
    const target = servers.value.find((s) => s.id === id)
    if (target) target.name = name
    await persist()
  }

  async function rememberUser(id: string, userId: string): Promise<void> {
    // 内置服务端的实例只存在于内存，不需要落库
    if (!integrated.value) await touchServer(id, { lastUserId: userId })
    const target = servers.value.find((s) => s.id === id)
    if (target) target.lastUserId = userId
    await persist()
  }

  async function remove(id: string): Promise<void> {
    if (integrated.value) return
    const target = servers.value.find((s) => s.id === id)
    if (hasLocalDb()) await removeServerCascade(id)
    // 删服务器时一并清掉该地址下的附件缓存，避免留下无法再访问的旧文件
    if (target) await clearAttachmentCache({ namespace: target.baseUrl })
    servers.value = servers.value.filter((s) => s.id !== id)
    if (currentId.value === id) {
      const next = servers.value[0]?.id ?? null
      currentId.value = next
      if (next) localStorage.setItem(CURRENT_KEY, next)
      else localStorage.removeItem(CURRENT_KEY)
    }
    await persist()
  }

  return {
    servers,
    currentId,
    current,
    hasServer,
    serverInfo,
    loading,
    error,
    integrated,
    localToken,
    hydrate,
    persist,
    probe,
    add,
    setCurrent,
    refreshInfo,
    rename,
    rememberUser,
    remove,
  }
})
