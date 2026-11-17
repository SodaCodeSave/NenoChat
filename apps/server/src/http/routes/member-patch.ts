import type { z } from 'zod'
import type { UpdateMemberSchema } from '@nenochat/shared'
import type { UpdateMemberInput } from '../../db/repo/members'

/**
 * 把 HTTP 层的成员更新入参转成 repo 层入参。
 * 单独抽出来是因为 nullable 字段要区分「没传」和「显式置空」，
 * 而 undefined 正好表达「没传」。
 */
export function toMemberPatch(input: z.infer<typeof UpdateMemberSchema>): UpdateMemberInput {
  const patch: UpdateMemberInput = {}
  if (input.role !== undefined) patch.role = input.role
  if (input.nickname !== undefined) patch.nickname = input.nickname
  if (input.allow !== undefined) patch.allow = input.allow
  if (input.deny !== undefined) patch.deny = input.deny
  if (input.muteUntil !== undefined) patch.muteUntil = input.muteUntil
  if (input.notificationLevel !== undefined) patch.notificationLevel = input.notificationLevel
  return patch
}
