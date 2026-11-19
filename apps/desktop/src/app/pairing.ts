import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link'
import { isTauri } from '@/platform/device'
import { useAuthStore } from '@/stores/auth'
import { useServersStore } from '@/stores/servers'

/** 二维码里携带的接入信息：电脑地址 + 一次性配对码 */
export interface PairTarget {
  url: string
  code: string
  name: string | null
}

/**
 * 解析 nenochat://pair?url=...&code=...&name=...
 * 不是配对链接或参数不全时返回 null，交给调用方忽略。
 */
export function parsePairLink(raw: string): PairTarget | null {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'nenochat:' || parsed.host !== 'pair') return null
  const url = parsed.searchParams.get('url')
  const code = parsed.searchParams.get('code')
  if (!url || !code) return null
  return { url, code, name: parsed.searchParams.get('name') }
}

/** 扫码接入：先登记电脑端地址，再用配对码换会话 */
export async function applyPairLink(target: PairTarget): Promise<void> {
  const servers = useServersStore()
  const instance = await servers.add(target.url, target.name ?? undefined)
  await servers.setCurrent(instance.id)
  await useAuthStore().pairWithCode(target.code)
}

/** 冷启动时取一次：扫码会直接唤起客户端，链接从这里拿到 */
export async function takeStartupPairLink(): Promise<PairTarget | null> {
  if (!isTauri()) return null
  try {
    const urls = await getCurrent()
    for (const url of urls ?? []) {
      const target = parsePairLink(url)
      if (target) return target
    }
    return null
  } catch {
    return null
  }
}

/** 应用已在前台时再扫一次码 */
export async function listenPairLink(handler: (target: PairTarget) => void): Promise<void> {
  if (!isTauri()) return
  try {
    await onOpenUrl((urls) => {
      for (const url of urls) {
        const target = parsePairLink(url)
        if (target) handler(target)
      }
    })
  } catch (e) {
    console.warn('[pairing] 监听扫码链接失败', e)
  }
}
