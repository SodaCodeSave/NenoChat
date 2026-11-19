/**
 * 自动更新的纯逻辑部分：版本比较、检查限频、环境判断。
 * 不依赖 Tauri 运行时，方便单测；调用侧在 composables/use-updater.ts。
 */

/** 每日最多自动检查一次 */
export const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

/** localStorage 里存上次自动检查时间戳的键 */
export const LAST_CHECK_KEY = 'nenochat.update.lastCheck'

/** 解析 semver 版本号为可比较的数字段，非法段按 0 处理 */
function parseSemver(version: string): number[] {
  const core = version.trim().replace(/^v/i, '').split('-')[0]
  return core.split('.').map((part) => {
    const n = Number.parseInt(part, 10)
    return Number.isFinite(n) ? n : 0
  })
}

/** 比较两个 semver 版本：a 大于 b 返回 1，小于返回 -1，相等返回 0 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0
    const nb = pb[i] ?? 0
    if (na !== nb) return na > nb ? 1 : -1
  }
  return 0
}

/** 距上次检查是否已超过限频间隔，从未检查过视为需要检查 */
export function shouldCheckNow(
  lastCheckMs: number | null,
  nowMs: number,
  intervalMs: number = AUTO_CHECK_INTERVAL_MS,
): boolean {
  if (lastCheckMs === null) return true
  return nowMs - lastCheckMs >= intervalMs
}

/** 读取上次自动检查的时间戳，缺失或损坏返回 null */
export function readLastCheck(): number | null {
  try {
    const raw = localStorage.getItem(LAST_CHECK_KEY)
    if (!raw) return null
    const ms = Number(raw)
    return Number.isFinite(ms) ? ms : null
  } catch {
    return null
  }
}

/** 记录本次检查时间戳，存储失败静默忽略（隐私模式等场景） */
export function writeLastCheck(nowMs: number): void {
  try {
    localStorage.setItem(LAST_CHECK_KEY, String(nowMs))
  } catch {
    // 存不了就存不了，下次多检查一次而已
  }
}

/**
 * 当前环境是否支持自动更新：只在 Tauri 桌面端生效。
 * 浏览器没有原生侧；updater 插件也不支持 Android/iOS。
 */
export function updateSupported(isTauriEnv: boolean, platform: string): boolean {
  return isTauriEnv && platform !== 'android' && platform !== 'ios'
}
