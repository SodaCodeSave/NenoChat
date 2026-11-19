import { describe, expect, it } from 'vitest'
import {
  buildDownloadSection,
  describeAsset,
  upsertDownloadSection,
} from '../../../scripts/release-notes.mjs'

const asset = (name, size = 120 * 1024 * 1024) => ({
  name,
  size,
  browser_download_url: `https://github.com/o/r/releases/download/v1.0.0/${name}`,
})

describe('describeAsset', () => {
  it('区分一体版与联网版，不把一体版的 exe 认成联网版', () => {
    expect(describeAsset('NenoChat-Integrated_1.0.0_x64-setup.exe')?.label).toContain('一体版')
    expect(describeAsset('NenoChat-Integrated_1.0.0_x64_en-US.msi')?.label).toContain('一体版')
    expect(describeAsset('NenoChat_1.0.0_x64-setup.exe')?.label).toContain('联网版')
    expect(describeAsset('NenoChat_1.0.0_x64_en-US.msi')?.label).toContain('联网版')
  })

  it('安卓与 Linux 资产', () => {
    expect(describeAsset('NenoChat-v1.0.0-android-arm64.apk')?.label).toBe('Android arm64')
    expect(describeAsset('NenoChat_1.0.0_amd64.AppImage')?.label).toContain('AppImage')
    expect(describeAsset('NenoChat_1.0.0_amd64.deb')?.label).toContain('deb')
  })

  it('认不出来的资产不进表格', () => {
    expect(describeAsset('source.tar.gz')).toBeNull()
    expect(describeAsset('checksums.txt')).toBeNull()
  })
})

describe('buildDownloadSection', () => {
  it('按平台顺序生成表格行', () => {
    const section = buildDownloadSection([
      asset('NenoChat-v1.0.0-android-arm64.apk', 30 * 1024 * 1024),
      asset('NenoChat_1.0.0_amd64.deb', 8 * 1024 * 1024),
      asset('NenoChat_1.0.0_x64-setup.exe'),
      asset('NenoChat-Integrated_1.0.0_x64-setup.exe', 200 * 1024 * 1024),
      asset('checksums.txt', 12),
    ])

    const order = ['一体版（安装程序）', '联网版（安装程序）', 'Android arm64', 'Linux x64（deb）']
    const positions = order.map((label) => section.indexOf(label))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    expect(section).not.toContain('checksums.txt')
  })

  it('表格包含文件名、大小与下载链接', () => {
    const section = buildDownloadSection([asset('NenoChat_1.0.0_amd64.AppImage', 1024 * 1024)])
    expect(section).toContain('| 平台 | 文件 | 大小 | 下载 |')
    expect(section).toContain('`NenoChat_1.0.0_amd64.AppImage`')
    expect(section).toContain('1.0 MB')
    expect(section).toContain('https://github.com/o/r/releases/download/v1.0.0/NenoChat_1.0.0_amd64.AppImage')
  })

  it('没有可识别资产时返回空串', () => {
    expect(buildDownloadSection([])).toBe('')
    expect(buildDownloadSection([asset('notes.txt')])).toBe('')
  })
})

describe('upsertDownloadSection', () => {
  const section = buildDownloadSection([asset('NenoChat_1.0.0_amd64.deb')])

  it('插到自动生成的变更日志前面', () => {
    const body = upsertDownloadSection('## What\u2019s Changed\n\n- 修了个 bug', section)
    expect(body.startsWith('<!-- downloads:start -->')).toBe(true)
    expect(body.indexOf('## 下载')).toBeLessThan(body.indexOf('## What'))
    expect(body).toContain('- 修了个 bug')
  })

  it('重复执行不会堆叠区块', () => {
    const once = upsertDownloadSection('## 变更', section)
    const twice = upsertDownloadSection(once, section)
    expect(twice.match(/<!-- downloads:start -->/g)).toHaveLength(1)
    expect(twice).toBe(once)
  })

  it('本次没有安装包时只清理旧区块', () => {
    const once = upsertDownloadSection('## 变更', section)
    expect(upsertDownloadSection(once, '')).toBe('## 变更')
  })
})
