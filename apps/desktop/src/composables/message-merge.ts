import { MESSAGE_MEMORY_WINDOW, type Message } from '@nenochat/shared'

/**
 * 消息数组的合并入口。反复出现的「同一条消息显示两遍」全部收敛到这里。
 *
 * 两条不变量：
 * 1. 同一 id 只有一条（服务端权威行唯一标识）。
 * 2. 同一 clientNonce 只有一条（本地乐观行与权威行是同一句话的两种形态，权威行胜出）。
 *
 * 第 2 条是关键：乐观行的 id 由客户端生成（ulid），权威行的 id 由服务端生成，
 * 两行 id 不同但 nonce 相同；只按 id 去重会留下两条一模一样的消息。
 */
export function mergeMessages(
  base: Message[],
  incoming: Message[],
  window: number = MESSAGE_MEMORY_WINDOW,
): Message[] {
  const byId = new Map<string, Message>()
  /** nonce → 当前占位的 id，用来找到需要被权威行顶掉的乐观行 */
  const idByNonce = new Map<string, string>()

  for (const message of base) {
    byId.set(message.id, message)
    if (message.clientNonce) idByNonce.set(message.clientNonce, message.id)
  }

  for (const message of incoming) {
    if (message.clientNonce) {
      const shadowId = idByNonce.get(message.clientNonce)
      if (shadowId && shadowId !== message.id) byId.delete(shadowId)
      idByNonce.set(message.clientNonce, message.id)
    }

    const existing = byId.get(message.id)
    byId.set(message.id, existing ? { ...existing, ...message } : message)
  }

  return sortAndTrim([...byId.values()], window)
}

/**
 * 历史里可能残留旧版本造成的「同人、同句、不同 nonce」重复行。
 * 渲染前按很窄的时间窗（默认 800ms）折叠，不删除数据、也不影响本地库。
 * 真实的手动重复（复制粘贴）通常远超这个间隔，不会被误伤。
 */
export function collapseAccidentalDuplicates(list: Message[], windowMs = 800): Message[] {
  const output: Message[] = []
  const seen = new Set<string>()

  for (const message of list) {
    if (seen.has(message.id)) continue
    seen.add(message.id)

    const prev = output[output.length - 1]
    if (
      prev &&
      message.content.trim().length > 0 &&
      message.type !== 'system' &&
      prev.type === message.type &&
      prev.senderId === message.senderId &&
      prev.content.trim() === message.content.trim() &&
      message.createdAt - prev.createdAt < windowMs
    ) {
      continue
    }

    output.push(message)
  }

  return output
}

/** 按 seq 排序（seq 相同按创建时间），并只保留最近一段，滚出去的历史从本地库回读 */
export function sortAndTrim(list: Message[], window: number = MESSAGE_MEMORY_WINDOW): Message[] {
  const sorted = [...list].sort((a, b) => {
    if (a.seq !== b.seq) return a.seq - b.seq
    return a.createdAt - b.createdAt
  })
  return sorted.length > window ? sorted.slice(-window) : sorted
}
