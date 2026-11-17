import { z } from 'zod'
import { PASSWORD_MIN_LENGTH, USERNAME_PATTERN } from '../constants'

/** 客户端设备标识，注册/登录时上报，用于多设备管理与远程登出 */
export const DeviceInfoSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  platform: z.string().min(1).max(32),
  appVersion: z.string().max(32).optional(),
})
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>

const UsernameSchema = z
  .string()
  .regex(USERNAME_PATTERN, '用户名需为 3-24 位字母、数字或下划线')

const PasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `密码至少 ${PASSWORD_MIN_LENGTH} 位`)
  .max(128, '密码过长')

export const RegisterSchema = z.object({
  username: UsernameSchema,
  password: PasswordSchema,
  displayName: z.string().trim().min(1, '昵称不能为空').max(32, '昵称过长'),
  inviteCode: z.string().trim().max(64).optional(),
  device: DeviceInfoSchema,
})
export type RegisterInput = z.infer<typeof RegisterSchema>

export const LoginSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
  device: DeviceInfoSchema,
})
export type LoginInput = z.infer<typeof LoginSchema>

export const RefreshSchema = z.object({
  refreshToken: z.string().min(10),
  device: DeviceInfoSchema.pick({ id: true }),
})
export type RefreshInput = z.infer<typeof RefreshSchema>

export const LogoutSchema = z.object({
  refreshToken: z.string().min(10).optional(),
  allDevices: z.boolean().optional(),
})

export const UpdateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(32).optional(),
  avatarUrl: z.string().max(512).nullable().optional(),
  bio: z.string().max(200).nullable().optional(),
})
export type UpdateProfileInput = z.infer<typeof UpdateProfileSchema>

export const ChangePasswordSchema = z.object({
  oldPassword: z.string().min(1),
  newPassword: PasswordSchema,
})

/** 登录/注册成功返回的凭证对 */
export interface AuthTokens {
  accessToken: string
  refreshToken: string
  expiresIn: number
}
