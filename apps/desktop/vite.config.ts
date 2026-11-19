import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { readGitInfo, resolveVersion } from '../../scripts/version.mjs'

const host = process.env.TAURI_DEV_HOST
const appVersion = resolveVersion({ env: process.env, gitInfo: readGitInfo() }).appVersion

export default defineConfig(() => ({
  plugins: [vue(), tailwindcss()],

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
