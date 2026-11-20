import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './device'

/**
 * 敏感数据存储。
 * 桌面端写入操作系统钥匙串；钥匙串不可用的平台（如移动端）
 * 以及浏览器端统一降级到 WebView 本地存储，受系统应用沙箱保护。
 */
const prefix = 'nenochat.secret.'

export async function setSecret(key: string, value: string): Promise<void> {
  if (isTauri()) {
    try {
      await invoke('secret_set', { account: key, value })
      return
    } catch (e) {
      console.warn('[secret] 钥匙串写入失败，降级到本地存储', e)
    }
  }
  try {
    localStorage.setItem(prefix + key, value)
  } catch {
    /* 隐私模式下可能不可用 */
  }
}

export async function getSecret(key: string): Promise<string> {
  if (isTauri()) {
    try {
      const value = await invoke<string>('secret_get', { account: key })
      if (value) return value
    } catch (e) {
      console.error('[secret] 钥匙串读取失败', e)
    }
  }
  try {
    return localStorage.getItem(prefix + key) ?? ''
  } catch {
    return ''
  }
}

export async function deleteSecret(key: string): Promise<void> {
  if (isTauri()) {
    try {
      await invoke('secret_delete', { account: key })
    } catch {
      /* 忽略 */
    }
  }
  try {
    localStorage.removeItem(prefix + key)
  } catch {
    /* 忽略 */
  }
}
