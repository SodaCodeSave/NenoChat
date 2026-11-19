#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { readGitInfo, resolveVersion } from './version.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 替换 JSON 文本中的首个 version 字段 */
export function replaceJsonVersion(content, version) {
  const next = content.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`)
  if (next === content) throw new Error('未找到 version 字段')
  return next
}

/** 替换 Cargo.toml 中 [package] 的 version 字段 */
export function replaceTomlVersion(content, version) {
  const next = content.replace(/(\[package\][\s\S]*?\bversion\s*=\s*")[^"]*(")/, `$1${version}$2`)
  if (next === content) throw new Error('未找到 [package].version 字段')
  return next
}

/** 替换 Cargo.lock 中根包（nenochat）的 version 字段 */
export function replaceCargoLockVersion(content, version) {
  const next = content.replace(/(\[\[package\]\]\nname = "nenochat"\nversion = ")[^"]*(")/, `$1${version}$2`)
  if (next === content) throw new Error('未找到 Cargo.lock 中 nenochat 版本')
  return next
}

function write(rel, transform) {
  const file = path.join(ROOT, rel)
  writeFileSync(file, transform(readFileSync(file, 'utf8')))
  process.stdout.write(`已更新 ${rel}\n`)
}

function main() {
  const { packageVersion } = resolveVersion({ env: process.env, gitInfo: readGitInfo() })
  process.stdout.write(`同步安装包版本: ${packageVersion}\n`)

  for (const rel of [
    'package.json',
    'apps/server/package.json',
    'apps/desktop/package.json',
    'packages/shared/package.json',
  ]) {
    write(rel, (s) => replaceJsonVersion(s, packageVersion))
  }
  write('apps/desktop/src-tauri/tauri.conf.json', (s) => replaceJsonVersion(s, packageVersion))
  write('apps/desktop/src-tauri/Cargo.toml', (s) => replaceTomlVersion(s, packageVersion))
  write('apps/desktop/src-tauri/Cargo.lock', (s) => replaceCargoLockVersion(s, packageVersion))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
