#!/usr/bin/env node
// 把各平台安装包的下载表格写进 Release 说明，位置在标题之下、自动生成的变更日志之上。
// 用真实资产列表生成，文件名规则变化时表格会跟着变，不需要手改。
import { pathToFileURL } from 'node:url'

const SECTION_START = '<!-- downloads:start -->'
const SECTION_END = '<!-- downloads:end -->'

/** 资产名 → 展示信息；order 决定表格里的行顺序 */
const RULES = [
  {
    test: /^NenoChat-Integrated_.*\.exe$/i,
    order: 10,
    label: 'Windows x64 · 一体版（安装程序）',
  },
  { test: /^NenoChat-Integrated_.*\.msi$/i, order: 11, label: 'Windows x64 · 一体版（MSI）' },
  { test: /^NenoChat_.*x64-setup\.exe$/i, order: 20, label: 'Windows x64 · 联网版（安装程序）' },
  { test: /^NenoChat_.*\.msi$/i, order: 21, label: 'Windows x64 · 联网版（MSI）' },
  { test: /\.apk$/i, order: 30, label: 'Android arm64' },
  { test: /\.AppImage$/i, order: 40, label: 'Linux x64（AppImage）' },
  { test: /\.deb$/i, order: 41, label: 'Linux x64（deb）' },
]

/** 文件名对应的平台信息，认不出来返回 null（不会进表格） */
export function describeAsset(name) {
  for (const rule of RULES) {
    if (rule.test.test(name)) return { label: rule.label, order: rule.order }
  }
  return null
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '-'
  const mb = bytes / 1024 / 1024
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/**
 * 生成下载区块。assets 用 GitHub API 的形状（name / size / browser_download_url）。
 * 没有可识别的资产时返回空字符串，调用方据此跳过。
 */
export function buildDownloadSection(assets) {
  const rows = (assets ?? [])
    .map((asset) => ({ asset, meta: describeAsset(asset.name) }))
    .filter((row) => row.meta !== null)
    .sort((a, b) => a.meta.order - b.meta.order || a.asset.name.localeCompare(b.asset.name))

  if (rows.length === 0) return ''

  const lines = [
    SECTION_START,
    '## 下载',
    '',
    '> 一体版内置服务端与 Node 运行时，装完免登录直接可用；联网版需要连接你自己的服务端地址。',
    '> 两者标识符不同，可以同时安装。',
    '',
    '| 平台 | 文件 | 大小 | 下载 |',
    '| --- | --- | --- | --- |',
    ...rows.map(
      ({ asset, meta }) =>
        `| ${meta.label} | \`${asset.name}\` | ${formatSize(asset.size)} | [下载](${asset.browser_download_url}) |`,
    ),
    '',
    'Android 安装包需要在系统里允许「安装未知来源应用」。',
    SECTION_END,
  ]
  return lines.join('\n')
}

/**
 * 把下载区块插到说明最前面；已经存在旧区块时先摘掉再插，重复跑不会堆叠。
 * section 为空表示本次没有可展示的安装包，此时只做清理。
 */
export function upsertDownloadSection(body, section) {
  const withoutSection = String(body ?? '')
    // 连同区块后面那条分隔线一起摘掉，否则重复执行会堆出多条 ---
    .replace(new RegExp(`${SECTION_START}[\\s\\S]*?${SECTION_END}\\s*(?:---\\s*)?`), '')
    .trim()
  if (!section) return withoutSection
  return withoutSection ? `${section}\n\n---\n\n${withoutSection}` : section
}

async function github(path, init = {}) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (!token) throw new Error('缺少 GITHUB_TOKEN')
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'nenochat-release-notes',
      ...(init.headers ?? {}),
    },
  })
  if (!response.ok) {
    throw new Error(`GitHub API ${path} 返回 ${response.status}：${await response.text()}`)
  }
  return response.json()
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY
  const tag = process.env.GITHUB_REF_NAME
  if (!repo || !tag) throw new Error('缺少 GITHUB_REPOSITORY / GITHUB_REF_NAME')

  const release = await github(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`)
  const section = buildDownloadSection(release.assets)
  const body = upsertDownloadSection(release.body, section)

  await github(`/repos/${repo}/releases/${release.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ body }),
  })
  console.log(`已把 ${release.assets?.length ?? 0} 个资产的下载表格写入 ${tag} 的说明`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error('[release-notes]', e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
