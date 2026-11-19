import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './device'

/** 随包服务端的连接信息，token 是客户端进程启动时注入的握手凭证 */
export interface LocalServerInfo {
  baseUrl: string
  wsUrl: string
  token: string
  /** 是否已开放到局域网（手机可接入） */
  lanEnabled: boolean
  /** 开放时给手机用的地址，未开放为 null */
  lanUrl: string | null
}

let pending: Promise<LocalServerInfo | null> | null = null

/**
 * 读取内置服务端信息。
 * 返回 null 表示这是普通联网版；抛错则说明是一体化版但服务端没起来，需要显式报给用户。
 */
export function localServerInfo(): Promise<LocalServerInfo | null> {
  if (!isTauri()) return Promise.resolve(null)
  if (!pending) {
    pending = invoke<LocalServerInfo | null>('local_server_info').then(null, (e: unknown) => {
      // 清掉缓存，让重试按钮能真正重新问一次
      pending = null
      throw e instanceof Error ? e : new Error(String(e))
    })
  }
  return pending
}

/** 开关「允许手机接入」：主进程会切换监听地址并重启服务端，返回新的地址信息 */
export async function setLanAccess(enabled: boolean): Promise<LocalServerInfo> {
  const info = await invoke<LocalServerInfo>('local_server_set_lan', { enabled })
  pending = Promise.resolve(info)
  return info
}
