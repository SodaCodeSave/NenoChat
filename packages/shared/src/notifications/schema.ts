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

export const NotificationListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** 取早于该时间戳的记录，用于翻页 */
  before: z.coerce.number().int().positive().optional(),
})
export type NotificationListQuery = z.infer<typeof NotificationListQuerySchema>

export const MarkNotificationsReadSchema = z
  .object({
    ids: z.array(z.string().min(1)).max(100).optional(),
    all: z.boolean().optional(),
  })
  .refine((input) => input.all === true || (input.ids?.length ?? 0) > 0, {
    message: '需要指定 ids 或 all',
  })
export type MarkNotificationsReadInput = z.infer<typeof MarkNotificationsReadSchema>
