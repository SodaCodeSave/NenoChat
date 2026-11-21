import { computed, ref } from 'vue'
import {
  base64ToBlob,
  nativeVoiceBridgeAvailable,
  nativeVoiceCancel,
  nativeVoiceStart,
  nativeVoiceStop,
} from '@/platform/voice-recorder'

/**
 * 语音录制：Android App 里走原生 MediaRecorder 桥（platform/voice-recorder），
 * 桌面端与浏览器用 getUserMedia + MediaRecorder。
 * 录完返回一个可直接 uploadFile 的 File，时长由计时器估算（原生侧回传精确值）。
 */

export interface VoiceRecording {
  file: File
  durationMs: number
}

export type RecorderState = 'idle' | 'recording' | 'processing'

const MAX_DURATION_MS = 120_000

export function useVoiceRecorder() {
  const state = ref<RecorderState>('idle')
  const seconds = ref(0)
  const error = ref<string | null>(null)

  let timer: ReturnType<typeof setInterval> | null = null
  let startedAt = 0
  let recorder: MediaRecorder | null = null
  let stream: MediaStream | null = null
  let chunks: Blob[] = []

  const recording = computed(() => state.value === 'recording')

  function startTimer(): void {
    startedAt = Date.now()
    seconds.value = 0
    timer = setInterval(() => {
      seconds.value = Math.floor((Date.now() - startedAt) / 1000)
      // 到上限自动收尾，避免忘记停止一直录下去
      if (Date.now() - startedAt >= MAX_DURATION_MS) void stop()
    }, 250)
  }

  function stopTimer(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  function cleanupWebRecording(): void {
    recorder = null
    stream?.getTracks().forEach((track) => track.stop())
    stream = null
    chunks = []
  }

  async function start(): Promise<boolean> {
    if (state.value !== 'idle') return false
    error.value = null

    if (nativeVoiceBridgeAvailable()) {
      const result = nativeVoiceStart()
      if (!result.ok) {
        error.value = result.error ?? '无法启动录音'
        return false
      }
      state.value = 'recording'
      startTimer()
      return true
    }

    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      error.value = '当前环境不支持语音录制'
      return false
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      error.value = '无法访问麦克风，请检查系统麦克风权限'
      return false
    }
    try {
      // 优先 opus/webm（Chromium 系内核都支持），拿不到就用浏览器默认格式
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : ''
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
    } catch {
      error.value = '无法启动录音'
      stream.getTracks().forEach((track) => track.stop())
      stream = null
      return false
    }
    chunks = []
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    }
    recorder.start(250)
    state.value = 'recording'
    startTimer()
    return true
  }

  async function stop(): Promise<VoiceRecording | null> {
    if (state.value !== 'recording') return null
    const durationMs = Date.now() - startedAt
    if (durationMs < 300) {
      await cancel()
      error.value = '说话时间太短了'
      return null
    }
    state.value = 'processing'
    stopTimer()

    if (nativeVoiceBridgeAvailable()) {
      const payload = await nativeVoiceStop()
      state.value = 'idle'
      if (!payload || !payload.base64) {
        error.value = '录音保存失败，请再试一次'
        return null
      }
      const ext = payload.mime.includes('wav') ? 'wav' : payload.mime.includes('mp4') ? 'm4a' : 'webm'
      return {
        file: new File([base64ToBlob(payload.base64, payload.mime)], `voice-${Date.now()}.${ext}`, {
          type: payload.mime,
        }),
        durationMs: payload.durationMs || durationMs,
      }
    }

    const media = recorder
    if (!media || media.state === 'inactive') {
      cleanupWebRecording()
      state.value = 'idle'
      error.value = '录音保存失败，请再试一次'
      return null
    }
    const file = await new Promise<VoiceRecording | null>((resolve) => {
      media.onstop = () => {
        const blob = new Blob(chunks, { type: media.mimeType || 'audio/webm' })
        const ext = blob.type.includes('wav') ? 'wav' : blob.type.includes('ogg') ? 'ogg' : 'webm'
        resolve({
          file: new File([blob], `voice-${Date.now()}.${ext}`, { type: blob.type }),
          durationMs,
        })
      }
      // 个别内核 onstop 后事件循环才释放轨道，先停轨不阻塞文件收尾
      try {
        media.stop()
      } catch {
        resolve(null)
      }
    })
    cleanupWebRecording()
    state.value = 'idle'
    if (!file) error.value = '录音保存失败，请再试一次'
    return file
  }

  async function cancel(): Promise<void> {
    if (state.value === 'idle') return
    stopTimer()
    if (nativeVoiceBridgeAvailable()) {
      nativeVoiceCancel()
      state.value = 'idle'
      return
    }
    const media = recorder
    if (media && media.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        media.onstop = () => resolve()
        try {
          media.stop()
        } catch {
          resolve()
        }
      })
    }
    cleanupWebRecording()
    state.value = 'idle'
  }

  return { state, recording, seconds, error, start, stop, cancel }
}
