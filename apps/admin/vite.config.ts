import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [vue(), tailwindcss()],

  // 面板由服务端托管在 /admin/ 子路径下，资源引用必须带上这个前缀，
  // 否则浏览器会去站点根找 /assets/* 而 404，页面白屏
  base: '/admin/',

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // 共享包直接指向源码，免去构建步骤（与 desktop 一致）
      '@nenochat/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },

  // 独立端口：1420 被 desktop 占用（strictPort），避免互相抢占
  server: {
    port: 1430,
    strictPort: true,
  },

  // 产物直接落到服务端的静态托管目录，服务端启动即发现即挂载
  build: {
    outDir: '../server/public/admin',
    emptyOutDir: true,
    target: 'chrome110',
    sourcemap: false,
  },
})
