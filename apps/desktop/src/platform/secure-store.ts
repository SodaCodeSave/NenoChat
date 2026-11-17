import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './device'

/**
 * 敏感数据存储。
 * 桌面端写入操作系统钥匙串；浏览器端只能退化为 localStorage（并在设置页明确提示）。
 */
const prefix = 'nenochat.secret.'

export async function setSecret(key: string, value: string): Promise<void> {
  if (isTauri()) {
    await invoke('secret_set', { account: key, value })
    return
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
      return await invoke<string>('secret_get', { account: key })
    } catch (e) {
      console.error('[secret] 读取失败', e)
      return ''
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
    await invoke('secret_delete', { account: key })
    return
  }
  try {
    localStorage.removeItem(prefix + key)
  } catch {
    /* 忽略 */
  }
}
