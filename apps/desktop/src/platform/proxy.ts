/**
 * 环回代理映射：Android WebView 154+ 启用 Local Network Access 后，
 * 从应用页面（本地上下文）直接 fetch/ws 私网 IP 会被无提示拦截（Failed to fetch）。
 * Android 端把真实服务器地址映射为 Rust 侧环回代理（127.0.0.1 随机端口），
 * 代理转发到真实服务器；其他平台原样直连。
 */
import { invoke } from '@tauri-apps/api/core'
import { isTauri, platformName } from './device'

export interface MappedUrls {
  baseUrl: string
  wsUrl: string
}

/** wsUrl 由代理地址推导：代理只认 http(s)，ws(s) 路径原样透传 */
function wsFromBase(proxyBase: string, realWsUrl: string): string {
  // 真实 wsUrl 的 path 部分（通常是 /ws，可能带 query）
  const wsUrl = new URL(realWsUrl)
  return `${proxyBase.replace(/^http/, 'ws')}${wsUrl.pathname}${wsUrl.search}`
}

export async function mapServerUrls(realBaseUrl: string, realWsUrl: string): Promise<MappedUrls> {
  if (!isTauri() || platformName() !== 'android') {
    return { baseUrl: realBaseUrl, wsUrl: realWsUrl }
  }
  try {
    const proxyBase = await invoke<string>('proxy_set_target', { target: realBaseUrl })
    return { baseUrl: proxyBase, wsUrl: wsFromBase(proxyBase, realWsUrl) }
  } catch (e) {
    // 代理失败时回退直连，至少桌面路径行为不受影响
    console.error('[proxy] 环回代理设置失败，回退直连', e)
    return { baseUrl: realBaseUrl, wsUrl: realWsUrl }
  }
}
