import { describe, expect, it } from 'vitest'
import { extractBalance } from '../src/services/ai-service'

describe('余额接口响应解析', () => {
  it('识别 DeepSeek 的 balance_infos', () => {
    const hit = extractBalance(
      'https://api.deepseek.com/user/balance',
      {
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00' }],
      },
    )
    expect(hit).toEqual({ amount: 110, currency: 'CNY' })
  })

  it('识别 Moonshot 的 available_balance', () => {
    const hit = extractBalance(
      'https://api.moonshot.cn/v1/users/me/balance',
      { code: 0, data: { available_balance: 49.58894, voucher_balance: 46, cash_balance: 3 } },
    )
    expect(hit).toEqual({ amount: 49.58894, currency: 'CNY' })
  })

  it('识别硅基流动的 totalBalance，缺省回退 balance', () => {
    const hit = extractBalance('https://api.siliconflow.cn/v1/user/info', {
      code: 20000,
      data: { balance: '0.88', chargeBalance: '88.00', totalBalance: '88.88' },
    })
    expect(hit).toEqual({ amount: 88.88, currency: 'CNY' })
    const fallback = extractBalance('https://api.siliconflow.cn/v1/user/info', {
      data: { balance: '1.2' },
    })
    expect(fallback).toEqual({ amount: 1.2, currency: 'CNY' })
  })

  it('识别 OpenRouter 的 credits 差值', () => {
    const hit = extractBalance('https://openrouter.ai/api/v1/credits', {
      data: { total_credits: 20, total_usage: 7.5 },
    })
    expect(hit).toEqual({ amount: 12.5, currency: 'USD' })
  })

  it('识别 one-api 订阅接口的总额度并标记需要查 usage', () => {
    const hit = extractBalance('https://relay.example.com/v1/dashboard/billing/subscription', {
      object: 'billing_subscription',
      hard_limit_usd: 125.5,
    })
    expect(hit).toEqual({ amount: 125.5, currency: 'USD', needsUsage: true })
    const direct = extractBalance('https://relay.example.com/v1/dashboard/billing/subscription', {
      hard_limit_usd: 125.5,
      balance: 23.8,
    })
    expect(direct).toEqual({ amount: 23.8, currency: 'USD' })
  })

  it('无关地址或异常字段返回 null', () => {
    expect(extractBalance('https://x.com/user/info', { data: null })).toBeNull()
    expect(extractBalance('https://x.com/user/info', { data: { totalBalance: 'abc' } })).toBeNull()
    expect(extractBalance('https://x.com/unknown', { foo: 1 })).toBeNull()
    expect(extractBalance('https://api.deepseek.com/user/balance', {})).toBeNull()
  })
})
