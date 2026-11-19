/**
 * AI 服务商设置页推广横幅的数据与逻辑。
 * 简介里的模型名与单价按 PROVIDER_AD_MODELS 顺序轮换展示。
 */

export interface ProviderAdModel {
  /** 轮换展示的模型名 */
  name: string
  /** 展示单价，形如「0.56/1M」；货币符号由简介模板统一给出 */
  price: string
}

/** 推广落地页（含推广参数，勿改动） */
export const PROVIDER_AD_LINK = 'https://ai.anmc.cn/sign-up?aff=u0pn'

/** 品牌名 */
export const PROVIDER_AD_TITLE = 'TokenRouter'

/** 简介中的固定文案，只有模型名与单价两段参与滚动轮换 */
export const PROVIDER_AD_DESCRIPTION_PARTS = {
  prefix: '低价AI中转站，',
  middle: '输出仅 ¥',
} as const

/** 完整简介模板：{model}、{price} 分别替换为模型名与单价 */
export const PROVIDER_AD_DESCRIPTION_TEMPLATE =
  `${PROVIDER_AD_DESCRIPTION_PARTS.prefix}{model}` +
  PROVIDER_AD_DESCRIPTION_PARTS.middle +
  '{price}'

/** 轮换间隔（毫秒） */
export const PROVIDER_AD_ROTATION_MS = 4000

/** 轮换展示的模型与单价 */
export const PROVIDER_AD_MODELS: ProviderAdModel[] = [
  { name: 'GLM 5.3 Flash', price: '0.56/1M' },
  { name: 'DeepSeek v4.1 Flash', price: '1.6/1M' },
  { name: 'GPT 6 Luna', price: '0.415/1M' },
  { name: 'Qwen 3.8 Flash', price: '0.658/1M' },
]

/** 按模板拼出一条简介 */
export function providerAdDescription(model: ProviderAdModel): string {
  return PROVIDER_AD_DESCRIPTION_TEMPLATE.replace('{model}', model.name).replace(
    '{price}',
    model.price,
  )
}

/** 取下一个轮换下标，到末尾后回到开头 */
export function nextProviderAdIndex(index: number): number {
  if (PROVIDER_AD_MODELS.length === 0) return 0
  return (index + 1) % PROVIDER_AD_MODELS.length
}
