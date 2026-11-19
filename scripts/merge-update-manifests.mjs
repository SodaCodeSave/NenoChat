#!/usr/bin/env node
// 把各构建 job 上传的 update-partial-*.json 合并成最终的 latest.json
// （联网版）与 latest-integrated.json（一体版）传回 Release，然后清掉
// partial 资产。清单里的 notes 取 Release 说明正文，更新弹窗直接展示。
import { pathToFileURL } from 'node:url'

const REGULAR_TARGET = 'latest.json'
const INTEGRATED_TARGET = 'latest-integrated.json'
const PARTIAL_PREFIX = 'update-partial-'

function headers(token, extra = {}) {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'nenochat-updater-manifests',
    ...extra,
  }
}

async function github(path, { token, ...init } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: headers(token, init.headers ?? {}),
  })
  if (!response.ok) {
    throw new Error(`GitHub API ${path} 返回 ${response.status}：${await response.text()}`)
  }
  return response.json()
}

/** 下载资产原始内容：octet-stream 是 API 对私有仓库取内容的标准姿势 */
async function downloadAsset(url, token) {
  const response = await fetch(url, {
    headers: headers(token, { accept: 'application/octet-stream' }),
  })
  if (!response.ok) throw new Error(`下载资产失败 ${url}：${response.status}`)
  return response.text()
}

async function uploadAsset(releaseId, name, body, token) {
  const response = await fetch(
    `https://uploads.github.com/repos/${process.env.GITHUB_REPOSITORY}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: headers(token, { 'content-type': 'application/octet-stream' }),
      body,
    },
  )
  if (!response.ok) throw new Error(`上传 ${name} 失败 ${response.status}：${await response.text()}`)
}

/** 同名资产已存在（比如重跑 Release）时先删再传 */
async function deleteAsset(assetId, token) {
  const response = await fetch(
    `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/releases/assets/${assetId}`,
    { method: 'DELETE', headers: headers(token) },
  )
  if (!response.ok && response.status !== 404) {
    throw new Error(`删除资产 ${assetId} 失败：${response.status}`)
  }
}

/** 合并多个 partial：同平台条目必须一致，版本号不一致说明 tag 混了，直接报错 */
export function mergePartials(partials) {
  const version = partials[0].version
  const platforms = {}
  for (const partial of partials) {
    if (partial.version !== version) {
      throw new Error(`partial 版本不一致：${version} vs ${partial.version}`)
    }
    for (const [platform, entry] of Object.entries(partial.platforms ?? {})) {
      if (platforms[platform] && platforms[platform].signature !== entry.signature) {
        throw new Error(`平台 ${platform} 在多个 partial 里有不同签名`)
      }
      platforms[platform] = entry
    }
  }
  const pubDate = partials
    .map((p) => p.pub_date)
    .filter(Boolean)
    .sort()[0]
  return { version, pub_date: pubDate, platforms }
}

async function main() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  const repo = process.env.GITHUB_REPOSITORY
  const tag = process.env.GITHUB_REF_NAME
  if (!token || !repo || !tag) {
    throw new Error('缺少 GITHUB_TOKEN / GITHUB_REPOSITORY / GITHUB_REF_NAME')
  }

  const release = await github(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { token })
  const partials = release.assets.filter((asset) => asset.name.startsWith(PARTIAL_PREFIX))
  if (partials.length === 0) {
    console.error('[merge] Release 里没有任何 partial 清单，跳过合并')
    return
  }

  const byVariant = { regular: [], integrated: [] }
  for (const asset of partials) {
    const raw = await downloadAsset(asset.browser_download_url, token)
    const parsed = JSON.parse(raw)
    if (!byVariant[parsed.variant]) {
      throw new Error(`partial ${asset.name} 的 variant 非法：${parsed.variant}`)
    }
    byVariant[parsed.variant].push(parsed)
  }

  const notes = String(release.body ?? '').trim()
  for (const [variant, target] of [
    ['regular', REGULAR_TARGET],
    ['integrated', INTEGRATED_TARGET],
  ]) {
    if (byVariant[variant].length === 0) {
      console.log(`[merge] ${variant} 没有 partial，跳过 ${target}`)
      continue
    }
    const manifest = mergePartials(byVariant[variant])
    if (notes) manifest.notes = notes

    const existing = release.assets.find((asset) => asset.name === target)
    if (existing) await deleteAsset(existing.id, token)
    await uploadAsset(release.id, target, JSON.stringify(manifest, null, 2), token)
    console.log(`[merge] 已上传 ${target}（${Object.keys(manifest.platforms).join(', ')}）`)
  }

  for (const asset of partials) {
    await deleteAsset(asset.id, token)
  }
  console.log(`[merge] 已清理 ${partials.length} 个 partial 资产`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error('[merge]', e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
