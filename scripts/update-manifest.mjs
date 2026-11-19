#!/usr/bin/env node
// 为单个构建 job 生成 partial 更新清单：扫描 bundle 目录里带 .sig 签名的
// updater 产物（NSIS 的 *.exe.zip、AppImage 的 *.AppImage.tar.gz），输出
// 一个只含本平台条目的 JSON，交由 merge-update-manifests.mjs 汇总上传。
// 没找到任何签名产物时报错退出，避免因漏配签名密钥而静默产出废清单。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = 'SodaCodeSave/NenoChat'

/** 认得出的 updater 签名产物后缀 → 平台键 */
const ARTIFACT_KINDS = [
  { suffix: '.exe.zip.sig', platform: 'windows-x86_64' },
  { suffix: '.AppImage.tar.gz.sig', platform: 'linux-x86_64' },
]

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      // --bundle-dir 这类 kebab-case 参数统一转成 camelCase 键
      const key = argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      args[key] = argv[i + 1]
    }
  }
  return args
}

/** 递归收集 bundle 目录下的文件路径 */
function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, out)
    else out.push(full)
  }
  return out
}

export function collectUpdaterArtifacts(files) {
  const found = []
  for (const file of files) {
    const kind = ARTIFACT_KINDS.find((k) => file.endsWith(k.suffix))
    if (!kind) continue
    // .sig 内容是签名单行文本，清单里要的就是这段内容
    found.push({
      platform: kind.platform,
      file: file.slice(0, -'.sig'.length),
      signature: readFileSync(file, 'utf8').trim(),
    })
  }
  return found
}

export function buildPartialManifest({ tag, variant, artifacts, now = new Date() }) {
  const platforms = {}
  for (const { platform, file, signature } of artifacts) {
    if (platforms[platform]) {
      throw new Error(`同一平台出现多个 updater 产物：${platform}`)
    }
    const name = file.split(/[\\/]/).pop()
    platforms[platform] = {
      signature,
      url: `https://github.com/${REPO}/releases/download/${tag}/${encodeURIComponent(name)}`,
    }
  }
  return {
    variant,
    version: tag.replace(/^v/, ''),
    pub_date: now.toISOString(),
    platforms,
  }
}

function main() {
  const { tag, variant, bundleDir, out } = parseArgs(process.argv.slice(2))
  for (const [key, value] of Object.entries({ tag, variant, bundleDir, out })) {
    if (!value) {
      console.error(`缺少 --${key} 参数`)
      process.exit(1)
    }
  }

  const artifacts = collectUpdaterArtifacts(walkFiles(bundleDir))
  if (artifacts.length === 0) {
    console.error(`[update-manifest] ${bundleDir} 里没有找到带签名的 updater 产物`)
    console.error('[update-manifest] 请确认构建时设置了 TAURI_SIGNING_PRIVATE_KEY')
    process.exit(1)
  }

  const manifest = buildPartialManifest({ tag, variant, artifacts })
  writeFileSync(out, JSON.stringify(manifest, null, 2))
  console.log(`[update-manifest] ${Object.keys(manifest.platforms).join(', ')} -> ${out}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
