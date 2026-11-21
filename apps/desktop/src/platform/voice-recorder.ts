/**
 * 原生录音桥（Android）。
 * Android WebView 里 getUserMedia/MediaRecorder 需要给 WebChromeClient 接管
 * onPermissionRequest，容易与 Tauri 自己的 chrome client 冲突，所以录音走原生
 * MediaRecorder：JS 通过 NenoVoiceBridge 下发 start/stop/cancel，
 * 原生侧把录音文件以 base64 回传（回调 window.__nenoVoiceResult）。
 */

/** 原生侧回传的录音结果 */
export interface NativeVoiceRecording {
  /** base64 编码的音频文件内容（不含 data: 前缀） */
  base64: string
  /** 音频 MIME，如 audio/webm */
  mime: string
  /** 实际录音时长（毫秒） */
  durationMs: number
}

interface NativeVoiceBridge {
  /** 开始录音；返回 JSON { ok: true } 或 { ok: false, error } */
  start(): string
  /** 停止并回传录音；结果经 window.__nenoVoiceResult 回调 */
  stop(): string
  /** 丢弃当前录音 */
  cancel(): string
}

declare global {
  interface Window {
    NenoVoiceBridge?: NativeVoiceBridge
    __nenoVoiceResult?: (payload: string) => void
  }
}

export interface NativeStartResult {
  ok: boolean
  error?: string
}

function bridge(): NativeVoiceBridge | null {
  if (typeof window === 'undefined') return null
  const candidate = window.NenoVoiceBridge
  return candidate && typeof candidate.start === 'function' && typeof candidate.stop === 'function'
    ? candidate
    : null
}

/** 原生录音桥是否可用（仅 Android App 内注入） */
export function nativeVoiceBridgeAvailable(): boolean {
  return bridge() !== null
}

function parseResult(raw: string): NativeStartResult {
  try {
    const parsed = JSON.parse(raw) as Partial<NativeStartResult>
    return { ok: parsed.ok === true, error: typeof parsed.error === 'string' ? parsed.error : undefined }
  } catch {
    return { ok: false, error: '原生录音桥返回异常' }
  }
}

/** 请求原生开始录音（原生侧负责 RECORD_AUDIO 运行时权限） */
export function nativeVoiceStart(): NativeStartResult {
  const native = bridge()
  if (!native) return { ok: false, error: '原生录音桥不可用' }
  try {
    return parseResult(native.start())
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '启动原生录音失败' }
  }
}

/**
 * 请求原生停止录音并等待结果。
 * 原生侧在文件写完后回调 window.__nenoVoiceResult(JSON 字符串)。
 */
export function nativeVoiceStop(timeoutMs = 8_000): Promise<NativeVoiceRecording | null> {
  const native = bridge()
  if (!native) return Promise.resolve(null)

  return new Promise((resolve) => {
    let settled = false
    const finish = (payload: NativeVoiceRecording | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      delete window.__nenoVoiceResult
      resolve(payload)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    window.__nenoVoiceResult = (raw) => {
      try {
        const parsed = JSON.parse(raw) as Partial<NativeVoiceRecording>
        finish(
          parsed.base64 && parsed.mime
            ? { base64: parsed.base64, mime: parsed.mime, durationMs: Number(parsed.durationMs ?? 0) }
            : null,
        )
      } catch {
        finish(null)
      }
    }
    try {
      native.stop()
    } catch {
      finish(null)
    }
  })
}

/** 丢弃原生侧正在进行的录音 */
export function nativeVoiceCancel(): void {
  const native = bridge()
  if (!native) return
  try {
    native.cancel()
  } catch {
    /* 丢弃失败无需处理 */
  }
}

/** base64 → Blob：原生回传的录音转成可上传的 File */
export function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}
