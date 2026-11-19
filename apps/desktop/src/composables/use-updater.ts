import { reactive } from 'vue'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { isTauri, platformName } from '@/platform/device'
import {
  readLastCheck,
  shouldCheckNow,
  updateSupported,
  writeLastCheck,
} from '@/platform/update-check'

export type UpdaterStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'error'

interface UpdaterState {
  status: UpdaterStatus
  error: string
  /** 新版本号 */
  version: string
  /** 更新说明（Release Notes 正文） */
  notes: string
  /** 下载进度 0~1，未开始时为 0 */
  progress: number
  dialogOpen: boolean
}

const state = reactive<UpdaterState>({
  status: 'idle',
  error: '',
  version: '',
  notes: '',
  progress: 0,
  dialogOpen: false,
})

/** check() 返回的更新对象要在安装阶段用，模块内持有即可 */
let pendingUpdate: Update | null = null

/** 启动后延迟几秒再检查，避开启动高峰期的网络竞争 */
const STARTUP_DELAY_MS = 6000

/**
 * 检查更新。auto 为 true 表示启动时后台检查：一切静默，只有发现新版本才弹窗；
 * manual 为设置页手动触发：结果无论新旧都给出反馈。
 */
export async function checkForUpdates(auto: boolean): Promise<void> {
  if (!updateSupported(isTauri(), platformName())) {
    if (!auto) {
      state.status = 'error'
      state.error = '当前环境不支持自动更新'
    }
    return
  }
  if (state.status === 'checking' || state.status === 'downloading' || state.status === 'installing') {
    return
  }

  state.status = 'checking'
  state.error = ''
  try {
    writeLastCheck(Date.now())
    const update = await check()
    if (!update) {
      state.status = 'up-to-date'
      return
    }
    pendingUpdate = update
    state.version = update.version
    state.notes = update.body ?? ''
    state.progress = 0
    state.status = 'available'
    state.dialogOpen = true
  } catch (e) {
    state.status = 'error'
    state.error = e instanceof Error ? e.message : String(e)
    // 后台检查失败不打扰用户，错误只留在状态里供设置页查看
  }
}

/** 下载并安装更新，安装完成后重启（Windows 上安装器会先自动退出应用） */
export async function installUpdate(): Promise<void> {
  const update = pendingUpdate
  if (!update || state.status === 'downloading' || state.status === 'installing') return

  state.status = 'downloading'
  state.progress = 0
  state.error = ''
  try {
    let total = 0
    let downloaded = 0
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case 'Started':
          total = event.data.contentLength ?? 0
          break
        case 'Progress':
          downloaded += event.data.chunkLength
          if (total > 0) state.progress = Math.min(downloaded / total, 1)
          break
        case 'Finished':
          state.progress = 1
          break
      }
    })
    state.status = 'installing'
    await relaunch()
  } catch (e) {
    state.status = 'error'
    state.error = e instanceof Error ? e.message : String(e)
    state.dialogOpen = true
  }
}

export function dismissUpdateDialog(): void {
  state.dialogOpen = false
  if (state.status === 'up-to-date' || state.status === 'available') {
    state.status = 'idle'
  }
}

/**
 * 启动时的自动检查入口：限频每日一次，延迟执行避免挤占启动期网络。
 * 返回值只是方便测试观察，不参与 UI。
 */
export function scheduleStartupCheck(
  delayMs: number = STARTUP_DELAY_MS,
  timer: (fn: () => void, ms: number) => void = setTimeout,
): boolean {
  if (!updateSupported(isTauri(), platformName())) return false
  if (!shouldCheckNow(readLastCheck(), Date.now())) return false
  timer(() => {
    void checkForUpdates(true)
  }, delayMs)
  return true
}

/** 只读状态，供弹窗与设置页共享 */
export function updaterState(): UpdaterState {
  return state
}
