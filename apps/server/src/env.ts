import { z } from 'zod'

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(8787),
  /** 对外基础地址，用于拼装附件 URL */
  PUBLIC_BASE_URL: z.string().default('http://localhost:8787'),
  DATA_DIR: z.string().default('./data'),
  JWT_SECRET: z.string().min(16).default('dev-only-jwt-secret-change-me'),
  /** 用于加密服务端托管的 AI 密钥 */
  SECRET_KEY: z.string().min(16).default('dev-only-aes-secret-change-me'),
  /** open | invite | closed */
  REGISTRATION_MODE: z.enum(['open', 'invite', 'closed']).default('open'),
  SERVER_NAME: z.string().default('NenoChat'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** 允许跨域的来源，逗号分隔；* 表示全部 */
  CORS_ORIGINS: z.string().default('*'),
})

export type Env = z.infer<typeof EnvSchema>

function load(): Env {
  const parsed = EnvSchema.safeParse(process.env)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`环境变量校验失败 -> ${detail}`)
  }
  return parsed.data
}

export const env = load()

export const isDev = env.NODE_ENV !== 'production'

export const corsOrigins = env.CORS_ORIGINS === '*'
  ? true
  : env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
