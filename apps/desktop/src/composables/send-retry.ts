import { ApiError } from '@/api/http'

/**
 * 判断发送失败是否值得进 outbox 重试。
 * 只有网络/服务端临时故障才重试；4xx 业务错误（内容非法、无权限等）重发也不会成功。
 */
export function isRetryableSendError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status >= 500 || error.status === 429
  }
  if (error instanceof Error) {
    // WS 断连与请求超时都以普通 Error 抛出，文案固定
    return /OFFLINE|连接已断开|请求超时/.test(error.message)
  }
  return false
}
