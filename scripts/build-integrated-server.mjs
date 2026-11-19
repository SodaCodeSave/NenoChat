// 把服务端打成一个可以随客户端分发的自包含目录：
//   resources/server/
//     server.cjs          业务代码（esbuild 单文件，原生模块走外部依赖）
//     migrations/*.sql    数据库迁移脚本
//     node_modules/**     只在运行时需要、无法打包的原生模块
//     node(.exe)          与构建机同版本的 Node 运行时
// 客户端启动时直接 spawn 这份运行时，不再要求用户自己装 Node 或跑服务端。
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverDir = path.join(rootDir, 'apps/server')
const outDir = path.join(rootDir, 'apps/desktop/src-tauri/resources/server')
const requireFromServer = createRequire(path.join(serverDir, 'package.json'))
const esbuild = requireFromServer('esbuild')

const platform = process.platform
const arch = process.arch
const nodeBinaryName = platform === 'win32' ? 'node.exe' : 'node'

/** better-sqlite3 的预编译二进制按平台分目录，只留当前平台那一份 */
function sqlitePrebuildName() {
  const alias = { win32: 'win32', darwin: 'darwin', linux: 'linux' }[platform]
  if (!alias) throw new Error(`不支持的平台：${platform}`)
  return `${alias}-${arch}.node`
}

/** 解析包在 pnpm 虚拟仓库里的真实目录，避免把符号链接打进安装包 */
function realPackageDir(name) {
  return path.dirname(requireFromServer.resolve(`${name}/package.json`))
}

/** 复制目录时按相对路径过滤，用来剔掉源码、声明文件等运行期用不到的内容 */
function copyFiltered(from, to, keep) {
  cpSync(from, to, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      if (src === from) return true
      return keep(path.relative(from, src).split(path.sep).join('/'))
    },
  })
}

function copySqlite() {
  const from = realPackageDir('better-sqlite3')
  const to = path.join(outDir, 'node_modules/better-sqlite3')
  const prebuild = sqlitePrebuildName()
  copyFiltered(from, to, (rel) => {
    if (rel === 'package.json') return true
    // 目录本身也要放行，否则 cpSync 会把整棵子树剪掉
    if (rel === 'lib' || rel.startsWith('lib/')) return true
    if (rel === 'prebuilds') return true
    if (rel.startsWith('prebuilds/')) return rel === `prebuilds/${prebuild}`
    return false
  })
  if (!existsSync(path.join(to, 'prebuilds', prebuild))) {
    throw new Error(`better-sqlite3 缺少当前平台的预编译包：${prebuild}`)
  }
}

function copyArgon2() {
  // argon2 主包与各平台二进制包是 @node-rs 下的同级目录，整组复制才能互相解析
  const scopeDir = path.dirname(realPackageDir('@node-rs/argon2'))
  const to = path.join(outDir, 'node_modules/@node-rs')
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(scopeDir)) {
    const from = path.join(scopeDir, entry)
    if (!statSync(from).isDirectory()) continue
    copyFiltered(from, path.join(to, entry), (rel) => {
      // 运行期只需要入口脚本与编译产物，.d.ts、README 之类可以省掉
      if (rel === 'package.json') return true
      return /\.(js|cjs|mjs|node|json)$/.test(rel)
    })
  }
  if (!existsSync(path.join(to, 'argon2/index.js'))) {
    throw new Error('@node-rs/argon2 复制失败')
  }
}

function copyMigrations() {
  const from = path.join(serverDir, 'src/db/migrations')
  const to = path.join(outDir, 'migrations')
  mkdirSync(to, { recursive: true })
  for (const file of readdirSync(from)) {
    if (file.endsWith('.sql')) cpSync(path.join(from, file), path.join(to, file))
  }
  const count = readdirSync(to).length
  if (count === 0) throw new Error('没有找到任何迁移脚本')
  return count
}

function copyNodeRuntime() {
  const target = path.join(outDir, nodeBinaryName)
  cpSync(process.execPath, target)
  const mb = Math.round(statSync(target).size / (1024 * 1024))
  return mb
}

async function bundleServer() {
  const result = await esbuild.build({
    entryPoints: [path.join(serverDir, 'src/main.ts')],
    outfile: path.join(outDir, 'server.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
    // version.mjs 的 CLI 判定用不到 import.meta，打包成 CJS 时的告警可以忽略
    logOverride: { 'empty-import-meta': 'silent' },
    // 原生模块必须留在磁盘上，交给 Node 自己 require
    external: ['better-sqlite3', '@node-rs/argon2'],
    // 打包成 CJS 后没有 import.meta，迁移目录靠 __dirname 定位
    define: { 'import.meta.dirname': '__dirname' },
    banner: {
      js: '// NenoChat 一体化服务端，由 scripts/build-integrated-server.mjs 生成',
    },
    metafile: true,
  })
  const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0
  return Math.round(bytes / 1024)
}

async function main() {
  // Windows 上杀毒软件会短暂占用上一次生成的 node.exe，删不掉时重试几次
  rmSync(outDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  mkdirSync(outDir, { recursive: true })

  const bundleKb = await bundleServer()
  const migrationCount = copyMigrations()
  copySqlite()
  copyArgon2()
  const nodeMb = copyNodeRuntime()

  console.log(
    [
      `服务端运行时已生成：${path.relative(rootDir, outDir)}`,
      `  代码 ${bundleKb} KB · 迁移 ${migrationCount} 个 · Node 运行时 ${nodeMb} MB · 平台 ${platform}-${arch}`,
    ].join('\n'),
  )
}

main().catch((e) => {
  console.error('[build-integrated-server]', e)
  process.exit(1)
})
