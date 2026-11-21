import { testDatabaseUrl } from './helpers/pg'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

/**
 * 管理面板静态托管：ADMIN_DIST_DIR 指向的目录存在时挂载 /admin/，
 * 入口 HTML no-cache、带哈希资源长缓存；目录不存在时 API 不受影响。
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'nenochat-admin-static-'))
const adminDist = path.join(dataDir, 'admin-dist')
mkdirSync(path.join(adminDist, 'assets'), { recursive: true })
writeFileSync(
  path.join(adminDist, 'index.html'),
  '<!doctype html><html><head><title>NenoChat 管理面板</title></head><body></body></html>',
  'utf8',
)
writeFileSync(path.join(adminDist, 'assets', 'app.js'), 'console.log(1)', 'utf8')

process.env.NODE_ENV = 'test'
process.env.DATA_DIR = dataDir
process.env.DATABASE_URL = testDatabaseUrl(import.meta.url)
process.env.LOG_LEVEL = 'fatal'
process.env.JWT_SECRET = 'test-jwt-secret-at-least-16-chars'
process.env.SECRET_KEY = 'test-aes-secret-at-least-16-chars'
process.env.ADMIN_DIST_DIR = adminDist

let app: FastifyInstance

beforeAll(async () => {
  const { buildApp } = await import('../src/app')
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  await app.close()
  const { closeDb } = await import('../src/db')
  closeDb()
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* 临时目录残留不影响测试结果 */
  }
})

describe('管理面板静态托管', () => {
  it('GET /admin/ 返回入口 HTML 且不缓存', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.headers['cache-control']).toBe('no-cache')
    expect(res.body).toContain('管理面板')
  })

  it('GET /admin 重定向到 /admin/', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin' })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/admin/')
  })

  it('带内容哈希的资源长缓存', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/assets/app.js' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toContain('immutable')
  })

  it('不存在的资源返回 404，不影响 API', async () => {
    const missing = await app.inject({ method: 'GET', url: '/admin/assets/nope.js' })
    expect(missing.statusCode).toBe(404)

    const api = await app.inject({ method: 'GET', url: '/api/v1/admin/stats' })
    expect(api.statusCode).toBe(401)
  })

  it('hash 路由深链接（/admin/#/users）无需 SPA fallback，按入口 HTML 送达', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/?x=1' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('管理面板')
  })
})
