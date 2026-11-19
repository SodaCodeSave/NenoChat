import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

/**
 * Release 工作流的结构校验：平台 job、产物路径与下载表格的依赖关系
 * 都靠 YAML 描述，写错了只有发版时才会暴露，这里提前卡住。
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const workflow = parse(
  readFileSync(path.join(root, '.github/workflows/release-build.yml'), 'utf8'),
) as {
  on: { push: { tags: string[] } }
  jobs: Record<
    string,
    {
      'runs-on'?: string | string[]
      needs?: string | string[]
      steps?: { name?: string; run?: string; with?: { files?: string } }[]
    }
  >
}

const BUILD_JOBS = ['windows-x64', 'windows-x64-integrated', 'linux-x64', 'android-arm64']

function jobSteps(job: string): { name?: string; run?: string; with?: { files?: string } }[] {
  return workflow.jobs[job]?.steps ?? []
}

function runOf(job: string, match: RegExp): string {
  const step = jobSteps(job).find((s) => typeof s.run === 'string' && match.test(s.run))
  return step?.run ?? ''
}

describe('release-build 工作流', () => {
  it('由 v* tag 触发，并声明构建权限', () => {
    expect(workflow.on.push.tags).toContain('v*')
    expect(Object.keys(workflow.jobs)).toContain('create-release')
  })

  it('包含全部平台的构建 job', () => {
    for (const job of BUILD_JOBS) expect(Object.keys(workflow.jobs)).toContain(job)
  })

  it('Linux job 在 22.04 上只产 appimage 与 deb', () => {
    expect(workflow.jobs['linux-x64']!['runs-on']).toBe('ubuntu-22.04')
    const build = runOf('linux-x64', /tauri build/)
    expect(build).toContain('x86_64-unknown-linux-gnu')
    expect(build).toContain('--bundles appimage,deb')
    expect(build).not.toContain('rpm')
  })

  it('Linux 产物路径与实际输出目录一致', () => {
    const upload = jobSteps('linux-x64').find((s) => s.with?.files)?.with?.files ?? ''
    expect(upload).toContain('x86_64-unknown-linux-gnu/release/bundle/appimage/*.AppImage')
    expect(upload).toContain('x86_64-unknown-linux-gnu/release/bundle/deb/*.deb')
  })

  it('下载表格 job 等所有安装包上传完再执行', () => {
    const needs = workflow.jobs['release-notes']!.needs
    expect(Array.isArray(needs) ? needs.sort() : [needs]).toEqual([...BUILD_JOBS].sort())
    expect(runOf('release-notes', /release-notes\.mjs/)).toContain('node scripts/release-notes.mjs')
  })
})
