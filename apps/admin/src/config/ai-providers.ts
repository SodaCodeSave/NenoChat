import openaiIcon from '@lobehub/icons-static-svg/icons/openai.svg?raw'
import openaiTextIcon from '@lobehub/icons-static-svg/icons/openai-text.svg?raw'
import anthropicIcon from '@lobehub/icons-static-svg/icons/anthropic.svg?raw'
import anthropicTextIcon from '@lobehub/icons-static-svg/icons/anthropic-text.svg?raw'
import geminiIcon from '@lobehub/icons-static-svg/icons/gemini-color.svg?raw'
import geminiTextIcon from '@lobehub/icons-static-svg/icons/gemini-text.svg?raw'
import deepseekIcon from '@lobehub/icons-static-svg/icons/deepseek-color.svg?raw'
import deepseekTextIcon from '@lobehub/icons-static-svg/icons/deepseek-text.svg?raw'
import kimiIcon from '@lobehub/icons-static-svg/icons/kimi-color.svg?raw'
import kimiTextIcon from '@lobehub/icons-static-svg/icons/kimi-text.svg?raw'
import zhipuIcon from '@lobehub/icons-static-svg/icons/zhipu.svg?raw'
import zhipuTextIcon from '@lobehub/icons-static-svg/icons/zhipu-text.svg?raw'
import qwenIcon from '@lobehub/icons-static-svg/icons/qwen-color.svg?raw'
import qwenTextIcon from '@lobehub/icons-static-svg/icons/qwen-text.svg?raw'
import ollamaIcon from '@lobehub/icons-static-svg/icons/ollama.svg?raw'
import ollamaTextIcon from '@lobehub/icons-static-svg/icons/ollama-text.svg?raw'
import siliconcloudIcon from '@lobehub/icons-static-svg/icons/siliconcloud-color.svg?raw'
import siliconcloudTextIcon from '@lobehub/icons-static-svg/icons/siliconcloud-text.svg?raw'
import minimaxIcon from '@lobehub/icons-static-svg/icons/minimax-color.svg?raw'
import minimaxTextIcon from '@lobehub/icons-static-svg/icons/minimax-text.svg?raw'
import volcengineIcon from '@lobehub/icons-static-svg/icons/volcengine-color.svg?raw'
import volcengineTextIcon from '@lobehub/icons-static-svg/icons/volcengine-text.svg?raw'
import tokenrouterIcon from '@/assets/icons/tokenrouter.svg?raw'

export interface AiProviderPreset {
  id: string
  /** 预设展示名，悬浮提示与匹配兜底用 */
  label: string
  /** 写入表单的默认名称 */
  name: string
  baseUrl: string
  model: string
  /** SVG 源码，由 SvgIcon 内联渲染 */
  icon: string
  /** 字标 SVG 源码；没有字标的服务商留空回退显示文字 */
  textIcon?: string
  /** 用于把已保存的服务商匹配回图标的关键词（匹配 name 或 baseUrl，小写） */
  keywords: string[]
  /** 本地服务商，无需 API Key */
  keyless?: boolean
}

/** 常见 AI 供应商预设，均为 OpenAI 兼容端点 */
export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    icon: openaiIcon,
    textIcon: openaiTextIcon,
    keywords: ['openai', 'gpt'],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-5',
    icon: anthropicIcon,
    textIcon: anthropicTextIcon,
    keywords: ['anthropic', 'claude'],
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    icon: geminiIcon,
    textIcon: geminiTextIcon,
    keywords: ['gemini', 'generativelanguage.googleapis.com'],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    icon: deepseekIcon,
    textIcon: deepseekTextIcon,
    keywords: ['deepseek'],
  },
  {
    id: 'kimi',
    label: 'Kimi',
    name: 'Kimi (月之暗面)',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    icon: kimiIcon,
    textIcon: kimiTextIcon,
    keywords: ['moonshot', 'kimi'],
  },
  {
    id: 'zhipu',
    label: '智谱',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    icon: zhipuIcon,
    textIcon: zhipuTextIcon,
    keywords: ['bigmodel', 'zhipu', 'glm', '智谱'],
  },
  {
    id: 'bailian',
    label: '阿里百炼',
    name: '阿里百炼 (通义)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    icon: qwenIcon,
    textIcon: qwenTextIcon,
    keywords: ['dashscope', 'bailian', 'qwen', '通义', '百炼'],
  },
  {
    id: 'siliconcloud',
    label: '硅基流动',
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
    icon: siliconcloudIcon,
    textIcon: siliconcloudTextIcon,
    keywords: ['siliconflow', 'siliconcloud', '硅基'],
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.chat/v1',
    model: 'abab6.5s-chat',
    icon: minimaxIcon,
    textIcon: minimaxTextIcon,
    keywords: ['minimax', 'abab'],
  },
  {
    id: 'volcengine',
    label: '火山引擎',
    name: '火山方舟 (豆包)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-pro-32k',
    icon: volcengineIcon,
    textIcon: volcengineTextIcon,
    keywords: ['volcengine', 'volces', 'doubao', '豆包', '火山'],
  },
  {
    id: 'tokenrouter',
    label: 'TokenRouter',
    name: 'TokenRouter',
    baseUrl: 'https://ai.anmc.cn/v1',
    model: 'glm-5.3-flash',
    icon: tokenrouterIcon,
    keywords: ['tokenrouter', 'ai.anmc.cn', 'anmc'],
  },
  {
    id: 'ollama',
    label: 'Ollama',
    name: 'Ollama (本地)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5',
    icon: ollamaIcon,
    textIcon: ollamaTextIcon,
    keywords: ['ollama', 'localhost:11434'],
    keyless: true,
  },
]

/** 根据名称和端点猜测服务商图标，匹配不到返回 null */
export function matchProviderIcon(name: string, baseUrl: string): string | null {
  const haystack = `${name} ${baseUrl}`.toLowerCase()
  for (const preset of AI_PROVIDER_PRESETS) {
    if (preset.keywords.some((k) => haystack.includes(k))) return preset.icon
  }
  return null
}
