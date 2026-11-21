import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { readGitInfo, resolveVersion } from '../../scripts/version.mjs'

const host = process.env.TAURI_DEV_HOST
const appVersion = resolveVersion({ env: process.env, gitInfo: readGitInfo() }).appVersion

const VERSION_FILE_RE = /[\\/]src[\\/]version\.ts(?:\?.*)?$/

/**
 * 版本号不走静态 define 直接内联：dev server 启动后切 tag 不会触发任何源码
 * 变更，define 的旧值会一直留在模块缓存里，设置页版本号就不跟着 tag 走了。
 * 改为每次 transform version.ts 时现算版本号，并监听 .git 的 tag/HEAD 变化，
 * 变化时失效该模块并全量刷新。
 */
function appVersionPlugin(): Plugin {
  const currentVersion = () =>
    JSON.stringify(resolveVersion({ env: process.env, gitInfo: readGitInfo() }).appVersion)

  return {
    name: 'nenochat:app-version',
    transform(code, id) {
      if (!VERSION_FILE_RE.test(id)) return null
      return `/** 客户端版本，构建时由 Vite 注入（跟随 git tag 动态计算） */\nexport const CLIENT_VERSION = ${currentVersion()}\n`
    },
    configureServer(server) {
      const versionFile = path.resolve(server.config.root, 'src/version.ts')
      const reload = () => {
        const mod = server.moduleGraph.getModuleById(versionFile)
        if (mod) void server.moduleGraph.invalidateModule(mod)
        server.ws.send({ type: 'full-reload' })
      }
      // checkout 写 HEAD，打/删 tag 写 refs/tags 或 packed-refs
      server.watcher.add(['.git/HEAD', '.git/packed-refs', '.git/refs/tags'])
      server.watcher.on('change', (file) => {
        if (/[/\\]\.git[/\\](?:HEAD|packed-refs|refs[/\\]tags)/.test(file)) reload()
      })
    },
  }
}

export default defineConfig(() => ({
  plugins: [vue(), tailwindcss(), appVersionPlugin()],

  // 构建时注入客户端版本，避免把版本号写死在源码里
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // 更具体的前缀必须排在前面，否则会被入口别名吞掉
      '@nenochat/shared/notifications': fileURLToPath(
        new URL('../../packages/shared/src/notifications', import.meta.url),
      ),
      '@nenochat/shared/storage': fileURLToPath(
        new URL('../../packages/shared/src/storage', import.meta.url),
      ),
      '@nenochat/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },

  // Tauri 期望固定端口，被占用时直接失败而不是静默换端口
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },

  build: {
    target: 'chrome110',
    sourcemap: false,
    // 稳定的第三方库拆成独立 chunk：改业务代码不会使 vendor chunk 的缓存失效
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined
          // vue 全家桶（vue 本体与 @vue/* 运行时、vue-router、pinia）
          if (/[\\/]node_modules[\\/]@vue[\\/]|[\\/]node_modules[\\/](vue|vue-router|pinia)[\\/]/.test(id)) {
            return 'vue-vendor'
          }
          if (/[\\/]node_modules[\\/]reka-ui[\\/]/.test(id)) return 'ui-vendor'
          if (/[\\/]node_modules[\\/]zod[\\/]/.test(id)) return 'zod-vendor'
          if (/[\\/]node_modules[\\/]@vueuse[\\/]/.test(id)) return 'vueuse-vendor'
          if (/[\\/]node_modules[\\/]@tanstack[\\/](vue-virtual|virtual-core)[\\/]/.test(id)) {
            return 'virtual-vendor'
          }
          return undefined
        },
      },
    },
  },
}))
