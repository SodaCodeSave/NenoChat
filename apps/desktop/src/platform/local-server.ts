import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './device'

/** 随包服务端的连接信息，token 是客户端进程启动时注入的握手凭证 */
export interface LocalServerInfo {
  baseUrl: string
  wsUrl: string
  token: string
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
