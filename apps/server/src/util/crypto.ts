import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'
import argon2 from '@node-rs/argon2'
import { env } from '../env'

const ARGON2_OPTIONS = {
  // 19 MiB / 2 轮，兼顾安全与自建服务器的登录延迟
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS)
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password)
  } catch {
    return false
  }
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

/** 由 SECRET_KEY 派生的 32 字节密钥，用于加密服务端托管的 AI key。
 * scrypt 单次派生要 50-100ms，而每次加解密都会调用；env 在模块加载时
 * 校验冻结成常量、运行时不可变，派生结果缓存一次即可。 */
let cachedKey: Buffer | null = null

function deriveKey(): Buffer {
  if (!cachedKey) {
    cachedKey = scryptSync(env.SECRET_KEY, 'nenochat-secret-v1', 32)
  }
  return cachedKey
}

/** AES-256-GCM 加密，输出 base64url(iv).base64url(tag).base64url(cipher) */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join('.')
}

export function decryptSecret(payload: string): string {
  const [ivPart, tagPart, dataPart] = payload.split('.')
  if (!ivPart || !tagPart || !dataPart) throw new Error('密文格式不合法')
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(), Buffer.from(ivPart, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'))
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    // AES-GCM 认证失败基本只有一种原因：SECRET_KEY 与加密时不一致
    throw new Error('托管密钥解密失败：SECRET_KEY 与加密时不一致，请重新保存该密钥')
  }
}

/** 把密钥处理成 abcd****wxyz，用于接口回显 */
export function maskSecret(plain: string): string {
  if (plain.length <= 8) return '****'
  return `${plain.slice(0, 4)}****${plain.slice(-4)}`
}
