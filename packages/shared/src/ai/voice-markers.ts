/**
 * 语音消息标记协议。
 * 模型在回复文字的分条开头写 [[voice]]，落库前解析成真正的语音消息：
 * 服务端剥离标记后把剩余文字交给 MiMo TTS 合成，随语音消息一并落库。
 * 与表情标记 [[sticker:id]] 同一套思路：只认清单协议、无效标记当没发过。
 */

const MARKER_PATTERN = /\[\[voice\]\]/gi

export interface VoiceMarkerResult {
  /** 是否携带语音标记（整条消息转语音） */
  voice: boolean
  /** 去掉全部标记后的正文 */
  text: string
}

/**
 * 从一段文字里解析语音标记。
 * 标记出现在任意位置都算命中（通常模型会写在开头）；
 * 命中后整条分条转成语音，正文取去掉标记后的剩余内容。
 */
export function extractVoiceMarker(text: string): VoiceMarkerResult {
  let voice = false
  for (const _match of text.matchAll(MARKER_PATTERN)) {
    voice = true
    break
  }
  const cleaned = text
    .replace(MARKER_PATTERN, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
  return { voice: voice && cleaned.length > 0, text: cleaned }
}

/** 只把标记从文字里剔除；流式气泡等展示场景用 */
export function stripVoiceMarkers(text: string): string {
  return text
    .replace(MARKER_PATTERN, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/** 提示词里的语音使用说明；未开启语音工具时返回空串 */
export function renderVoiceBlock(): string {
  return [
    '【语音消息】',
    '你可以在合适的时候发语音消息：把 [[voice]] 标记写在某条回复的开头，系统会把这条回复转成语音发出，其余回复照常发文字。',
    '使用规则：',
    '- 语音适合短句、语气强烈的表达（问候、撒娇、感叹、安抚）；长解释、列表、链接请用文字。',
    '- 一条回复最多写一个标记，多余的会被忽略。',
    '- 标记后面的正文就是你要「说」出来的话，按口语写，不要写列表或 Markdown。',
    '- 不要解释你在发语音，也不要每条都用语音。',
  ].join('\n')
}
