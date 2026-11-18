import dns from 'node:dns/promises'
import net from 'node:net'

/** 判断 IP 是否为回环、内网、链路本地、云元数据或保留地址 */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map((part) => Number(part))
    const a = parts[0] ?? 0
    const b = parts[1] ?? 0
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    )
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase()
    if (lower === '::' || lower === '::1') return true
    if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isPrivateIp(mapped[1]!)
    return false
  }
  return false
}

export interface PublicUrlOptions {
  /** 是否允许访问私网地址，本地模型场景可开启 */
  allowPrivate?: boolean
}

/**
 * 校验 URL 是否可用于服务端代发请求。
 * 只允许 http(s)、禁止账号密码；默认拒绝回环/内网/保留地址，
 * 域名逐条解析 DNS 结果校验，避免域名指向内网。
 */
export async function assertPublicUrl(raw: string, options: PublicUrlOptions = {}): Promise<URL> {
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('不支持的链接协议')
  }
  if (url.username || url.password) throw new Error('链接不能包含账号密码')

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host) throw new Error('链接缺少域名')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    if (!options.allowPrivate) throw new Error('不允许访问内网地址')
    return url
  }

  if (net.isIP(host)) {
    if (!options.allowPrivate && isPrivateIp(host)) throw new Error('不允许访问内网地址')
    return url
  }

  if (options.allowPrivate) return url

  const records = await dns.lookup(host, { all: true, verbatim: true })
  if (records.length === 0) throw new Error('域名无法解析')
  for (const record of records) {
    if (isPrivateIp(record.address)) throw new Error('不允许访问内网地址')
  }
  return url
}
