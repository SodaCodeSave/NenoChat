import { describe, expect, it } from 'vitest'
import type { Message } from '@nenochat/shared'
import { collapseAccidentalDuplicates, mergeMessages } from './message-merge'

function make(partial: Partial<Message> & Pick<Message, 'id'>): Message {
  return {
    conversationId: 'c1',
    senderType: 'user',
    type: 'text',
    content: 'hi',
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  } as Message
}

describe('mergeMessages', () => {
  it('同一 clientNonce 的乐观行被权威行顶掉，只留一条', () => {
    const pending = make({ id: 'local-1', clientNonce: 'n1', seq: 3, localStatus: 'pending' })
    const confirmed = make({ id: 'server-1', clientNonce: 'n1', seq: 12 })

    const merged = mergeMessages([pending], [confirmed])

    expect(merged).toHaveLength(1)
    expect(merged[0]!.id).toBe('server-1')
  })

  it('同一 id 合并成一条并保留最新字段', () => {
    const old = make({ id: 'm1', content: '旧' })
    const next = make({ id: 'm1', content: '新' })

    const merged = mergeMessages([old], [next])

    expect(merged).toHaveLength(1)
    expect(merged[0]!.content).toBe('新')
  })

  it('同 id 合并时 meta 深合并，部分更新不丢字段', () => {
    const old = make({
      id: 'm1',
      meta: { mentions: ['u1'], clientNonce: 'n1' },
    })
    const next = make({ id: 'm1', meta: { emoji: '👍' } })

    const merged = mergeMessages([old], [next])

    expect(merged[0]!.meta).toMatchObject({
      mentions: ['u1'],
      clientNonce: 'n1',
      emoji: '👍',
    })
  })

  it('不同 nonce 的不同消息都保留', () => {
    const a = make({ id: 'm1', clientNonce: 'n1', seq: 1 })
    const b = make({ id: 'm2', clientNonce: 'n2', seq: 2 })

    expect(mergeMessages([a], [b])).toHaveLength(2)
  })

  it('按 seq 升序排列', () => {
    const merged = mergeMessages(
      [make({ id: 'b', seq: 5 }), make({ id: 'a', seq: 1 })],
      [make({ id: 'c', seq: 3 })],
    )

    expect(merged.map((m) => m.seq)).toEqual([1, 3, 5])
  })

  it('同人同句且间隔极短的重复行只留一条', () => {
    const first = make({ id: 'm1', seq: 1, content: '哈喽', createdAt: 1000 })
    const dup = make({ id: 'm2', seq: 2, content: '哈喽', createdAt: 1050 })

    const list = collapseAccidentalDuplicates([first, dup])
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe('m1')
  })

  it('间隔较长或内容不同的重复消息保留', () => {
    const first = make({ id: 'm1', seq: 1, content: '哈喽', createdAt: 1000 })
    const later = make({ id: 'm2', seq: 2, content: '哈喽', createdAt: 5000 })
    const other = make({ id: 'm3', seq: 3, content: '在吗', createdAt: 5050 })

    expect(collapseAccidentalDuplicates([first, later, other])).toHaveLength(3)
  })

  it('空内容的图片/贴纸消息不会被误合并', () => {
    const a = make({ id: 'm1', type: 'image', seq: 1, content: '', createdAt: 1000 })
    const b = make({ id: 'm2', type: 'image', seq: 2, content: '', createdAt: 1010 })

    expect(collapseAccidentalDuplicates([a, b])).toHaveLength(2)
  })

  it('超过窗口时裁掉最旧的', () => {
    const list = Array.from({ length: 5 }, (_, i) => make({ id: `m${i}`, seq: i }))
    const merged = mergeMessages([], list, 3)

    expect(merged.map((m) => m.seq)).toEqual([2, 3, 4])
  })
})
