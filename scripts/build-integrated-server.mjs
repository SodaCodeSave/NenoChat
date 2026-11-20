// 把服务端打成一个可以随客户端分发的自包含目录：
//   resources/server/
//     server.cjs          业务代码（esbuild 单文件，原生模块走外部依赖）
//     migrations/*.sql    数据库迁移脚本
//     node_modules/**     只在运行时需要、无法打包的 PostgreSQL 原生二进制
//     node(.exe)          与构建机同版本的 Node 运行时
// 客户端启动时直接 spawn 这份运行时，不再要求用户自己装 Node、PostgreSQL 或跑服务端。
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverDir = path.join(rootDir, 'apps/server')
const outDir = path.join(rootDir, 'apps/desktop/src-tauri/resources/server')
const requireFromServer = createRequire(path.join(serverDir, 'package.json'))
const esbuild = requireFromServer('esbuild')

/**
 * embedded-postgres 启动前会给 PG 二进制 chmod 补执行位；Windows 的可执行性
 * 不由 mode 位决定，NTFS 上的文件常常不带该位，触发无意义的 chmod——
 * 在 Program Files 这类受保护目录里直接 EPERM 崩溃。打包时打补丁跳过。
 */
const skipChmodOnWindows = {
  name: 'skip-chmod-on-windows',
  setup(build) {
    build.onLoad({ filter: /embedded-postgres[\\/]dist[\\/]index\.js$/ }, async (args) => {
      let code = await import('node:fs/promises').then((fs) => fs.readFile(args.path, 'utf8'))
      const target =
        'const ensureBinIsExecutable = (filePath) => __awaiter(void 0, void 0, void 0, function* () {'
      if (!code.includes(target)) {
        throw new Error('embedded-postgres 补丁点未找到，上游可能已更新实现')
      }
      code = code.replace(
        target,
        `${target}\n        if (platform() === 'win32') return;`,
      )
      return { contents: code, loader: 'js' }
    })
  },
}

const platform = process.platform
const arch = process.arch
const nodeBinaryName = platform === 'win32' ? 'node.exe' : 'node'

/** 解析包在 pnpm 虚拟仓库里的真实目录，避免把符号链接打进安装包 */
function realPackageDir(name) {
  const entry = requireFromServer.resolve(name)
  // 部分包的 exports 不暴露 package.json，从入口文件沿目录向上找名字匹配的包根
  let dir = path.dirname(entry)
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
      if (pkg.name === name) return dir
    } catch {
      // 不是包根，继续向上
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`无法定位包目录：${name}`)
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

/** 内嵌 PostgreSQL 的平台二进制（initdb/postgres 与全部动态库），一体版运行必须 */
function copyEmbeddedPg() {
  // Node 的平台名 win32 与二进制包的命名 windows 不一致，这里做一次映射
  const pkgPlatform = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[platform]
  if (!pkgPlatform) throw new Error(`不支持的平台：${platform}`)
  const pkgName = `@embedded-postgres/${pkgPlatform}-${arch}`
  const from = realPackageDir(pkgName)
  const to = path.join(outDir, 'node_modules/@embedded-postgres', `${pkgPlatform}-${arch}`)
  copyFiltered(from, to, (rel) => {
    // native/ 是二进制主体（约 100MB），dist/ 是定位它的入口脚本，
    // scripts/ 里有入口引用的 hydrate-symlinks.js，三组都必须保留
    if (rel === 'package.json' || rel === 'LICENSE.md') return true
    return (
      rel === 'dist' || rel.startsWith('dist/') ||
      rel === 'native' || rel.startsWith('native/') ||
      rel === 'scripts' || rel.startsWith('scripts/')
    )
  })
  if (!existsSync(path.join(to, 'package.json'))) {
    throw new Error(`${pkgName} 复制失败`)
  }
  const mb = Math.round(dirSize(to) / (1024 * 1024))
  return mb
}

function dirSize(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    total += entry.isDirectory() ? dirSize(full) : statSync(full).size
  }
  return total
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
    plugins: [skipChmodOnWindows],
    // version.mjs 的 CLI 判定用不到 import.meta，打包成 CJS 时的告警可以忽略
    logOverride: { 'empty-import-meta': 'silent' },
    // 原生模块必须留在磁盘上，交给 Node 自己 require；PG 平台二进制由
    // embedded-postgres 运行时按平台动态 import，同样走 node_modules 解析
    external: ['@node-rs/argon2', '@embedded-postgres/*'],
    // 打包成 CJS 后没有 import.meta，迁移目录靠 __dirname 定位
    define: { 'import.meta.dirname': '__dirname' },
    banner: {
      js: [
        '// NenoChat 一体化服务端，由 scripts/build-integrated-server.mjs 生成',
        '// GUI 环境里没有控制台：给所有子进程注入 windowsHide，防止 initdb/postgres 弹黑框',
        'const __nenoOriginalSpawn = require("node:child_process").spawn',
        'require("node:child_process").spawn = function (file, args, options) {',
        '  return __nenoOriginalSpawn(file, args, { ...(options ?? {}), windowsHide: true })',
        '}',
      ].join('\n'),
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
  copyArgon2()
  const pgMb = copyEmbeddedPg()
  const nodeMb = copyNodeRuntime()

  console.log(
    [
      `服务端运行时已生成：${path.relative(rootDir, outDir)}`,
      `  代码 ${bundleKb} KB · 迁移 ${migrationCount} 个 · PG 二进制 ${pgMb} MB · Node 运行时 ${nodeMb} MB · 平台 ${platform}-${arch}`,
    ].join('\n'),
  )
}

main().catch((e) => {
  console.error('[build-integrated-server]', e)
  process.exit(1)
})
