import { describe, expect, it } from 'vitest'
import {
  buildBilibiliSummaryPrompt,
  extractUrls,
  findBilibiliVideoId,
  parseBilibiliVideoId,
  renderBilibiliContext,
  renderWebSearchContext,
  shouldSearchWeb,
} from './connectors'
import type { BilibiliVideoMaterial, ConnectorSearchResult } from '../entities'

describe('extractUrls', () => {
  it('提取链接并去掉末尾标点', () => {
    expect(extractUrls('看这个 https://example.com/a?b=1，还有 https://b.com/x.')).toEqual([
      'https://example.com/a?b=1',
      'https://b.com/x',
    ])
  })

  it('去重且忽略非 http 链接', () => {
    expect(extractUrls('https://a.com https://a.com ftp://b.com')).toEqual(['https://a.com'])
  })
})

describe('parseBilibiliVideoId', () => {
  it('识别 BV 号与 av 号', () => {
    expect(parseBilibiliVideoId('BV1GJ411x7h7')).toBe('BV1GJ411x7h7')
    expect(parseBilibiliVideoId('av170001')).toBe('av170001')
    expect(parseBilibiliVideoId('BV1GJ411x7h7')).not.toBe('bv1gj411x7h7')
  })

  it('从视频链接里解析', () => {
    expect(parseBilibiliVideoId('https://www.bilibili.com/video/BV1GJ411x7h7/?spm_id_from=333')).toBe(
      'BV1GJ411x7h7',
    )
    expect(parseBilibiliVideoId('https://m.bilibili.com/video/av170001')).toBe('av170001')
  })

  it('拒绝非 B 站链接与短链', () => {
    expect(parseBilibiliVideoId('https://example.com/video/BV1GJ411x7h7')).toBeNull()
    expect(parseBilibiliVideoId('https://b23.tv/abc')).toBeNull()
  })

  it('findBilibiliVideoId 能从整句话里抓出 BV 号', () => {
    expect(findBilibiliVideoId('帮我看看 BV1GJ411x7h7 讲了什么')).toBe('BV1GJ411x7h7')
    expect(findBilibiliVideoId('今天天气不错')).toBeNull()
  })
})

describe('shouldSearchWeb', () => {
  it('明确检索意图时触发', () => {
    expect(shouldSearchWeb('帮我搜索一下 DeepSeek 最新进展')).toBe(true)
    expect(shouldSearchWeb('查一下今年北京车展的新闻')).toBe(true)
    expect(shouldSearchWeb('search the latest news about AI')).toBe(true)
  })

  it('普通闲聊与纯链接不触发', () => {
    expect(shouldSearchWeb('今天有点累')).toBe(false)
    expect(shouldSearchWeb('https://example.com/article')).toBe(false)
    expect(shouldSearchWeb('晚安')).toBe(false)
  })
})

describe('renderWebSearchContext', () => {
  it('渲染标题、链接与摘要', () => {
    const results: ConnectorSearchResult[] = [
      {
        title: 'DeepSeek V4',
        url: 'https://example.com/v4',
        snippet: '短摘要',
        summary: '长摘要内容',
        siteName: 'Example',
      },
    ]
    const text = renderWebSearchContext('DeepSeek', results)
    expect(text).toContain('【联网检索资料】')
    expect(text).toContain('DeepSeek V4')
    expect(text).toContain('https://example.com/v4')
    expect(text).toContain('长摘要内容')
  })

  it('没有结果时返回空串', () => {
    expect(renderWebSearchContext('x', [])).toBe('')
  })
})

describe('B 站上下文与总结提示词', () => {
  const material: BilibiliVideoMaterial = {
    video: {
      bvid: 'BV1GJ411x7h7',
      aid: 1,
      title: '测试视频',
      description: '视频简介',
      author: 'UP 主',
      cover: '',
      duration: 100,
      pubDate: 0,
      url: 'https://www.bilibili.com/video/BV1GJ411x7h7',
    },
    transcript: '',
    comments: [{ author: '观众 A', content: '很好看', like: 10 }],
    summary: null,
  }

  it('无字幕时标注降级并带热评', () => {
    const text = renderBilibiliContext(material)
    expect(text).toContain('没有可用字幕')
    expect(text).toContain('观众 A')
  })

  it('有字幕时使用字幕内容', () => {
    const text = renderBilibiliContext({ ...material, transcript: '大家好，今天讲一件事。' })
    expect(text).toContain('字幕转写')
    expect(text).not.toContain('没有可用字幕')
  })

  it('总结提示词区分有无字幕', () => {
    expect(buildBilibiliSummaryPrompt(material)).toContain('没有可用字幕')
    expect(buildBilibiliSummaryPrompt({ ...material, transcript: '字幕内容' })).toContain('字幕转写')
  })
})
