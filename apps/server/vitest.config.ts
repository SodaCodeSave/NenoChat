import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 每个用例文件都会独立建库、迁移并启动一个 Fastify 实例；
    // 文件并行时首次启动偶尔会超过默认的 10s。
    hookTimeout: 30_000,
    testTimeout: 20_000,
  },
})
