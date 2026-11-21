import { z } from 'zod'

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(8787),
  /** 对外基础地址，用于拼装附件 URL */
  PUBLIC_BASE_URL: z.string().default('http://localhost:8787'),
  DATA_DIR: z.string().default('./data'),
  /** PostgreSQL 连接串，如 postgres://user:pass@host:5432/nenochat */
  DATABASE_URL: z.string().default('postgres://nenochat:nenochat@localhost:5432/nenochat'),
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
  /** 一体化版：服务端与客户端同机运行，免密码登录 */
  LOCAL_MODE: z.enum(['true', 'false']).default('false'),
  /** 一体化版的握手密钥，由客户端进程启动时生成并注入 */
  LOCAL_AUTH_TOKEN: z.string().default(''),
  /** 一体化版是否对外开放到局域网（手机扫码接入），由客户端开关决定 */
  LAN_ENABLED: z.enum(['true', 'false']).default('false'),
  /** 管理面板静态资源目录；缺省用包内 public/admin，目录不存在则不挂载 */
  ADMIN_DIST_DIR: z.string().optional(),
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
  // 本地模式凭令牌免密登录，令牌太弱等于把账号交给同机任意进程
  if (parsed.data.LOCAL_MODE === 'true' && parsed.data.LOCAL_AUTH_TOKEN.length < 32) {
    throw new Error('本地模式必须注入至少 32 字符的 LOCAL_AUTH_TOKEN')
  }
  return parsed.data
}

export const env = load()

export const isDev = env.NODE_ENV !== 'production'

/** 一体化版服务端：只服务同机的客户端进程 */
export const localMode = env.LOCAL_MODE === 'true'

/** 手机配对：只有一体化版且用户主动开放局域网时才允许 */
export const pairingEnabled = localMode && env.LAN_ENABLED === 'true'

// 测试环境需要连接本地 mock 上游，默认放行；生产由显式开关控制
export const allowPrivateAiEndpoint = env.ALLOW_PRIVATE_AI_ENDPOINT === 'true' || env.NODE_ENV === 'test'

export const corsOrigins = env.CORS_ORIGINS === '*'
  ? true
  : env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
