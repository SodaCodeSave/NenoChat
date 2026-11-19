import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-deep-link', () => ({
  getCurrent: vi.fn(async () => null),
  onOpenUrl: vi.fn(async () => () => {}),
}))
vi.mock('@/platform/device', () => ({ isTauri: () => false }))

const { parsePairLink } = await import('./pairing')

describe('扫码接入链接', () => {
  it('解析出电脑地址与配对码', () => {
    const link =
      'nenochat://pair?url=' +
      encodeURIComponent('http://192.168.1.7:51234') +
      '&code=ABC123&name=' +
      encodeURIComponent('NenoChat 一体版')

    expect(parsePairLink(link)).toEqual({
      url: 'http://192.168.1.7:51234',
      code: 'ABC123',
      name: 'NenoChat 一体版',
    })
  })

  it('没有名字也能用', () => {
    const link = `nenochat://pair?url=${encodeURIComponent('http://10.0.0.2:8787')}&code=ZZZ999`
    expect(parsePairLink(link)?.name).toBeNull()
  })

  it('别的协议、别的主机、缺参数一律忽略', () => {
    expect(parsePairLink('https://pair?url=a&code=b')).toBeNull()
    expect(parsePairLink('nenochat://other?url=a&code=b')).toBeNull()
    expect(parsePairLink('nenochat://pair?code=ABC123')).toBeNull()
    expect(parsePairLink('nenochat://pair?url=http://a:1')).toBeNull()
    expect(parsePairLink('随便一段文字')).toBeNull()
  })
})
