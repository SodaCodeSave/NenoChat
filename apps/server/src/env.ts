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
  /** 允许 AI 服务商地址指向内网（本地模型如 ollama 需开启）；默认关闭以防 SSRF */
  ALLOW_PRIVATE_AI_ENDPOINT: z.enum(['true', 'false']).default('false'),
})

export type Env = z.infer<typeof EnvSchema>

/** 开发环境默认值，生产环境禁止使用 */
const DEV_JWT_SECRET = 'dev-only-jwt-secret-change-me'
const DEV_SECRET_KEY = 'dev-only-aes-secret-change-me'

function load(): Env {
  const parsed = EnvSchema.safeParse(process.env)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`环境变量校验失败 -> ${detail}`)
  }
  // 生产环境必须显式配置强密钥，杜绝默认值导致 JWT 可伪造、托管密钥可被解密
  if (parsed.data.NODE_ENV === 'production') {
    const jwt = process.env.JWT_SECRET
    const aes = process.env.SECRET_KEY
    if (!jwt || jwt.length < 32 || jwt === DEV_JWT_SECRET) {
      throw new Error('生产环境必须设置 JWT_SECRET（至少 32 字符，且不可使用开发默认值）')
    }
    if (!aes || aes.length < 32 || aes === DEV_SECRET_KEY) {
      throw new Error('生产环境必须设置 SECRET_KEY（至少 32 字符，且不可使用开发默认值）')
    }
  }
  return parsed.data
}

export const env = load()

export const isDev = env.NODE_ENV !== 'production'

// 测试环境需要连接本地 mock 上游，默认放行；生产由显式开关控制
export const allowPrivateAiEndpoint = env.ALLOW_PRIVATE_AI_ENDPOINT === 'true' || env.NODE_ENV === 'test'

export const corsOrigins = env.CORS_ORIGINS === '*'
  ? true
  : env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
