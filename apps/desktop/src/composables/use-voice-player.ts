import { ref } from 'vue'

/**
 * 语音消息播放器：全局单例 <audio>，同一时刻只播一条，
 * 点别的语音自动停掉上一条。播放状态由 playingUrl 标记，
 * 气泡上的按钮据此切换播放/停止样式。
 */

const playingUrl = ref<string | null>(null)
const loadingUrl = ref<string | null>(null)

let audio: HTMLAudioElement | null = null

function ensureAudio(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio()
    audio.addEventListener('ended', () => {
      playingUrl.value = null
    })
    audio.addEventListener('error', () => {
      playingUrl.value = null
      loadingUrl.value = null
    })
  }
  return audio
}

function stopPlayback(): void {
  if (!audio) return
  audio.pause()
  audio.currentTime = 0
  playingUrl.value = null
}

/** 播放/停止切换：正在播同一条时点击即停止，否则停旧的播新的 */
async function toggle(url: string): Promise<void> {
  if (playingUrl.value === url) {
    stopPlayback()
    return
  }
  const player = ensureAudio()
  stopPlayback()
  loadingUrl.value = url
  try {
    player.src = url
    await player.play()
    loadingUrl.value = null
    playingUrl.value = url
  } catch {
    // 播放被中断（快速连点、页面隐藏）或解码失败：状态回空，不打断界面
    loadingUrl.value = null
    playingUrl.value = null
  }
}

export function useVoicePlayer() {
  return { playingUrl, loadingUrl, toggle, stop: stopPlayback }
}
