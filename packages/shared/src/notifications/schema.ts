import { z } from 'zod'
import { NotificationLevel } from '../enums'

const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间格式应为 HH:mm')

/** 通知设置增量更新；未传字段保持原值 */
export const NotificationSettingsPatchSchema = z.object({
  desktopEnabled: z.boolean().optional(),
  soundEnabled: z.boolean().optional(),
  showPreview: z.boolean().optional(),
  dmLevel: z.enum([NotificationLevel.All, NotificationLevel.Mentions, NotificationLevel.None]).optional(),
  groupLevel: z.enum([NotificationLevel.All, NotificationLevel.Mentions, NotificationLevel.None]).optional(),
  dndEnabled: z.boolean().optional(),
  dndStart: timeOfDay.optional(),
  dndEnd: timeOfDay.optional(),
  timezone: z.string().min(1).max(64).optional(),
})
export type NotificationSettingsPatch = z.infer<typeof NotificationSettingsPatchSchema>
