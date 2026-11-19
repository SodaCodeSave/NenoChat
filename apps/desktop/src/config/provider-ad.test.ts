import { describe, expect, it } from 'vitest'
import {
  PROVIDER_AD_DESCRIPTION_PARTS,
  PROVIDER_AD_DESCRIPTION_TEMPLATE,
  PROVIDER_AD_LINK,
  PROVIDER_AD_MODELS,
  PROVIDER_AD_ROTATION_MS,
  PROVIDER_AD_TITLE,
  nextProviderAdIndex,
  providerAdDescription,
} from './provider-ad'

describe('provider-ad', () => {
  it('落地页、品牌与简介模板正确', () => {
    expect(PROVIDER_AD_LINK).toBe('https://ai.anmc.cn/sign-up?aff=u0pn')
    expect(PROVIDER_AD_TITLE).toBe('TokenRouter')
    expect(PROVIDER_AD_DESCRIPTION_TEMPLATE).toBe('低价AI中转站，{model}输出仅 ¥{price}')
    expect(PROVIDER_AD_DESCRIPTION_PARTS).toEqual({
      prefix: '低价AI中转站，',
      middle: '输出仅 ¥',
    })
  })

  it('包含四个轮换模型及其单价', () => {
    expect(PROVIDER_AD_MODELS).toEqual([
      { name: 'GLM 5.3 Flash', price: '0.56/1M' },
      { name: 'DeepSeek v4.1 Flash', price: '1.6/1M' },
      { name: 'GPT 6 Luna', price: '0.415/1M' },
      { name: 'Qwen 3.8 Flash', price: '0.658/1M' },
    ])
  })

  it('按模板拼出每条简介', () => {
    expect(PROVIDER_AD_MODELS.map(providerAdDescription)).toEqual([
      '低价AI中转站，GLM 5.3 Flash输出仅 ¥0.56/1M',
      '低价AI中转站，DeepSeek v4.1 Flash输出仅 ¥1.6/1M',
      '低价AI中转站，GPT 6 Luna输出仅 ¥0.415/1M',
      '低价AI中转站，Qwen 3.8 Flash输出仅 ¥0.658/1M',
    ])
  })

  it('轮换间隔为正数且下标循环回到开头', () => {
    expect(PROVIDER_AD_ROTATION_MS).toBeGreaterThan(0)
    expect(nextProviderAdIndex(0)).toBe(1)
    expect(nextProviderAdIndex(2)).toBe(3)
    expect(nextProviderAdIndex(PROVIDER_AD_MODELS.length - 1)).toBe(0)
  })
})
