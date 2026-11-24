import { describe, expect, it } from 'vitest'
import { buildMomentShareContent, momentSharePreview, parseMomentShare } from './moment-share'

describe('动态分享正文标记', () => {
  it('正文带上完整动态内容与定位标记，能反向还原卡片信息', () => {
    const content = buildMomentShareContent({
      postId: 'post-1',
      authorName: '爱丽丝',
      content: '今天去爬山了\n风景很好',
      coverUrl: 'https://example.com/a.png?x=1',
    })

    expect(content).toContain('爱丽丝：今天去爬山了 风景很好')
    expect(content).toContain('nenochat://moment/post-1')

    const parsed = parseMomentShare(content)
    expect(parsed?.postId).toBe('post-1')
    expect(parsed?.authorName).toBe('爱丽丝')
    expect(parsed?.excerpt).toBe('今天去爬山了 风景很好')
    expect(parsed?.coverUrl).toBe('https://example.com/a.png?x=1')
  })

  it('非动态消息不会被误判成卡片', () => {
    expect(parseMomentShare('普通聊天内容')).toBeNull()
  })

  it('列表摘要去掉定位标记，只留作者与正文', () => {
    const content = buildMomentShareContent({
      postId: 'post-1',
      authorName: '爱丽丝',
      content: '今天去爬山了',
      coverUrl: '/files/a.png',
    })

    expect(momentSharePreview(content)).toBe('[动态] 爱丽丝：今天去爬山了')
    expect(momentSharePreview(content)).not.toContain('nenochat://')
    expect(momentSharePreview('普通聊天内容')).toBeNull()
  })

  it('摘要按上限截断', () => {
    const content = buildMomentShareContent({
      postId: 'post-2',
      authorName: '爱丽丝',
      content: '啊'.repeat(100),
    })

    expect(momentSharePreview(content, 20)).toHaveLength(20)
  })
})
