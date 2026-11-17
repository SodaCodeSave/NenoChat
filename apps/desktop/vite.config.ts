import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

const host = process.env.TAURI_DEV_HOST

export default defineConfig(() => ({
  plugins: [vue(), tailwindcss()],

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
  },
}))
