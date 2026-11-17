/**
 * 粗略 token 估算：中文按 1 字约 0.65 token，其它非空白字符按 4 字符约 1 token。
 * 不引入 tiktoken，避免 wasm 体积与首屏加载延迟；误差对本产品的上下文预算足够。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    const isCjk =
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff)
    if (isCjk) cjk += 1
    else if (ch !== ' ' && ch !== '\n' && ch !== '\t' && ch !== '\r') other += 1
  }
  return Math.ceil(cjk * 0.65 + other * 0.25)
}
