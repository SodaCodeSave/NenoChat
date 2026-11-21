import { save } from '@tauri-apps/plugin-dialog'
import { writeFile } from '@tauri-apps/plugin-fs'
import { isTauri } from './device'

/**
 * PNG 图片的落盘。
 * 桌面端走系统保存对话框 + fs 插件；安卓 WebView 里由原生 MediaBridge
 * 写入系统相册（MediaStore）；浏览器模式退化为 a[download] 下载。
 */

const FILTER = { name: 'PNG 图片', extensions: ['png'] }

export interface SaveImageResult {
  /** 保存到哪里：desktop=所选路径，android=相册内容 URI，browser=下载 */
  target: 'desktop' | 'android' | 'browser'
  /** 桌面端为文件路径，安卓为返回的 URI，浏览器为空 */
  location: string | null
  bytes: number
}

interface NativeMediaBridge {
  /** 保存 PNG（base64，不含 data: 前缀）；返回 JSON { ok, uri?, error? } */
  savePng(fileName: string, base64: string): string
}

declare global {
  interface Window {
    NenoMediaBridge?: NativeMediaBridge
  }
}

function mediaBridge(): NativeMediaBridge | null {
  if (typeof window === 'undefined') return null
  const candidate = window.NenoMediaBridge
  return candidate && typeof candidate.savePng === 'function' ? candidate : null
}

/** 原生相册桥是否可用（仅 Android App 内注入） */
export function nativeMediaBridgeAvailable(): boolean {
  return mediaBridge() !== null
}

async function saveToAndroid(fileName: string, blob: Blob): Promise<SaveImageResult | null> {
  const native = mediaBridge()
  if (!native) return null
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const raw = String(reader.result ?? '')
      const index = raw.indexOf(',')
      resolve(index >= 0 ? raw.slice(index + 1) : '')
    }
    reader.onerror = () => reject(new Error('读取图片数据失败'))
    reader.readAsDataURL(blob)
  })

  let raw: string
  try {
    raw = native.savePng(fileName, base64)
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : '保存到相册失败')
  }
  try {
    const parsed = JSON.parse(raw) as { ok?: boolean; uri?: string; error?: string }
    if (!parsed.ok) throw new Error(parsed.error || '保存到相册失败')
    return { target: 'android', location: parsed.uri ?? null, bytes: blob.size }
  } catch (e) {
    throw e instanceof Error ? e : new Error('保存到相册失败')
  }
}

/** 保存 PNG 图片；用户取消返回 null，失败抛错由调用方展示 */
export async function savePngImage(fileName: string, blob: Blob): Promise<SaveImageResult | null> {
  if (isTauri() && nativeMediaBridgeAvailable()) {
    const android = await saveToAndroid(fileName, blob)
    if (android) return android
  }

  if (isTauri()) {
    const path = await save({ defaultPath: fileName, filters: [FILTER] })
    if (!path) return null
    await writeFile(path, new Uint8Array(await blob.arrayBuffer()))
    return { target: 'desktop', location: path, bytes: blob.size }
  }

  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return { target: 'browser', location: null, bytes: blob.size }
}
