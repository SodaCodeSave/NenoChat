import deepseekIcon from '@lobehub/icons-static-svg/icons/deepseek-color.svg?raw'
import deepseekTextIcon from '@lobehub/icons-static-svg/icons/deepseek-text.svg?raw'
import bilibiliIcon from '@lobehub/icons-static-svg/icons/bilibili-color.svg?raw'
import bilibiliTextIcon from '@lobehub/icons-static-svg/icons/bilibili-text.svg?raw'
import heweatherIcon from '@/assets/heweather-icon.svg?raw'
import heweatherTextIcon from '@/assets/heweather-text.svg?raw'
import type { ConnectorType } from '@nenochat/shared'

export interface ConnectorPreset {
  id: string
  type: ConnectorType
  /** 卡片标题 */
  label: string
  /** 新建连接器时写入的默认名称 */
  name: string
  description: string
  /** 连接器能做什么，卡片上第二条说明 */
  capability: string
  /** SVG 源码，由 SvgIcon 内联渲染 */
  icon: string
  /** 字标 SVG 源码 */
  textIcon?: string
}

/** 连接器预置：一张卡片对应一种数据源，凭据全部存在服务端 */
export const CONNECTOR_PRESETS: ConnectorPreset[] = [
  {
    id: 'deepseek-search',
    type: 'deepseek_search',
    label: 'DeepSeek 搜索',
    name: 'DeepSeek 搜索',
    description: '接入 DeepSeek 网页搜索，让 AI 能检索最新网页资料',
    capability: '用户明确要查资料时自动联网，结果只作为回复参考',
    icon: deepseekIcon,
    textIcon: deepseekTextIcon,
  },
  {
    id: 'heweather',
    type: 'heweather',
    label: '和风天气',
    name: '和风天气',
    description: '接入和风天气实时天气与预报',
    capability: '按配置注入天气上下文，或开放给 AI 按需查询',
    icon: heweatherIcon,
    textIcon: heweatherTextIcon,
  },
  {
    id: 'bilibili',
    type: 'bilibili',
    label: '哔哩哔哩',
    name: 'B 站视频',
    description: '识别聊天里的 B 站链接，抓取视频信息、字幕并生成总结',
    capability: '无字幕时降级为标题、简介与热评总结；总结静默注入对话',
    icon: bilibiliIcon,
    textIcon: bilibiliTextIcon,
  },
]

export function connectorPresetOf(type: ConnectorType): ConnectorPreset | null {
  return CONNECTOR_PRESETS.find((preset) => preset.type === type) ?? null
}
