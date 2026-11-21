import { z } from 'zod'

/**
 * 用户设置增量更新；未传字段保持原值。
 * 目前只暴露聊天背景两字段：theme/accent 等仍为纯本地偏好，
 * 背景图与提取主色跟账号走（各设备展示一致，主色不必重复提取）。
 */
export const UserSettingsPatchSchema = z.object({
  chatBgUrl: z.string().max(512).nullable().optional(),
  chatBgAccent: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, '主色应为 #rrggbb 格式')
    .nullable()
    .optional(),
})
export type UserSettingsPatch = z.infer<typeof UserSettingsPatchSchema>
