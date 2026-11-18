import { describe, expect, it } from 'vitest'
import { assertPublicUrl, isPrivateIp } from '../src/util/ssrf'

describe('isPrivateIp', () => {
  it('识别常见私网与保留地址', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '224.0.0.1']) {
      expect(isPrivateIp(ip)).toBe(true)
    }
  })

  it('公网地址返回 false', () => {
    expect(isPrivateIp('8.8.8.8')).toBe(false)
    expect(isPrivateIp('1.1.1.1')).toBe(false)
  })

  it('识别 IPv6 回环、链路本地与 IPv4 映射', () => {
    expect(isPrivateIp('::1')).toBe(true)
    expect(isPrivateIp('fe80::1')).toBe(true)
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true)
  })
})

describe('assertPublicUrl', () => {
  it('拒绝非 http(s) 协议', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow()
    await expect(assertPublicUrl('ftp://example.com')).rejects.toThrow()
  })

  it('拒绝带账号密码的地址', async () => {
    await expect(assertPublicUrl('https://user:pass@example.com')).rejects.toThrow('账号密码')
  })

  it('默认拒绝 localhost 与内网 IP', async () => {
    await expect(assertPublicUrl('http://localhost:11434')).rejects.toThrow('内网地址')
    await expect(assertPublicUrl('http://127.0.0.1:8080')).rejects.toThrow('内网地址')
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow('内网地址')
  })

  it('允许公网地址', async () => {
    await expect(assertPublicUrl('https://api.openai.com/v1')).resolves.toBeInstanceOf(URL)
  })

  it('allowPrivate 放行 localhost 与内网 IP', async () => {
    await expect(assertPublicUrl('http://localhost:11434', { allowPrivate: true })).resolves.toBeInstanceOf(URL)
    await expect(assertPublicUrl('http://192.168.1.10:8080', { allowPrivate: true })).resolves.toBeInstanceOf(URL)
  })
})
