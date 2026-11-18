import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api/http'
import { isRetryableSendError } from './send-retry'

describe('isRetryableSendError', () => {
  it('网络断连与超时可重试', () => {
    expect(isRetryableSendError(new Error('OFFLINE'))).toBe(true)
    expect(isRetryableSendError(new Error('连接已断开'))).toBe(true)
    expect(isRetryableSendError(new Error('请求超时'))).toBe(true)
  })

  it('服务端临时故障与限流可重试', () => {
    expect(isRetryableSendError(new ApiError('INTERNAL', 'x', 500))).toBe(true)
    expect(isRetryableSendError(new ApiError('RATE_LIMIT', 'x', 429))).toBe(true)
  })

  it('4xx 业务错误不重试', () => {
    expect(isRetryableSendError(new ApiError('FORBIDDEN', 'x', 403))).toBe(false)
    expect(isRetryableSendError(new ApiError('VALIDATION', 'x', 400))).toBe(false)
  })

  it('未知错误不重试', () => {
    expect(isRetryableSendError('oops')).toBe(false)
    expect(isRetryableSendError(new Error('消息内容不能为空'))).toBe(false)
  })
})
