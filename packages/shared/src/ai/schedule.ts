import type { AiScheduleItem } from '../entities'

/**
 * 角色日程的解析与整理。
 * 服务端和客户端都会用到：LLM 生成的结果先过一遍归一化，
 * 保证时间格式统一、按时间升序，手动编辑的输入也走同一套校验。
 */

const HM = /^([01]\d|2[0-3]):([0-5]\d)$/

export function isValidHm(value: string): boolean {
  return HM.test(value)
}

export function hmToMinutes(value: string): number | null {
  const match = HM.exec(value)
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

function cleanActivity(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, 60)
}

/**
 * 归一化一组日程：丢掉时间非法的项，按开始时间排序，
 * 开始时间相同的只保留第一条，最多 20 条。
 */
export function normalizeScheduleItems(input: unknown): AiScheduleItem[] {
  if (!Array.isArray(input)) return []

  const items: AiScheduleItem[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const record = raw as Record<string, unknown>
    const start = typeof record.start === 'string' ? record.start.trim() : ''
    const end = typeof record.end === 'string' ? record.end.trim() : ''
    const activity = cleanActivity(record.activity)
    if (!isValidHm(start) || !isValidHm(end) || !activity) continue
    const from = hmToMinutes(start)
    const to = hmToMinutes(end)
    if (from === null || to === null || to <= from) continue
    items.push({ start, end, activity })
  }

  items.sort((a, b) => (hmToMinutes(a.start) ?? 0) - (hmToMinutes(b.start) ?? 0))
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item.start)) return false
    seen.add(item.start)
    return true
  }).slice(0, 20)
}

/** 从模型输出里尽量抠出 JSON；失败时返回空数组，调用方决定如何兜底 */
export function parseScheduleItems(raw: string): AiScheduleItem[] {
  const text = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  const candidate = start >= 0 && end > start ? text.slice(start, end + 1) : text
  try {
    const parsed = JSON.parse(candidate) as unknown
    if (Array.isArray(parsed)) return normalizeScheduleItems(parsed)
    if (parsed && typeof parsed === 'object') {
      return normalizeScheduleItems((parsed as { items?: unknown }).items)
    }
  } catch {
    /* 落到空数组 */
  }
  return []
}

/** 当前时刻落在哪个日程里；没有则返回 null */
export function currentScheduleItem(
  items: AiScheduleItem[],
  nowMinutes: number,
): AiScheduleItem | null {
  for (const item of items) {
    const from = hmToMinutes(item.start)
    const to = hmToMinutes(item.end)
    if (from === null || to === null) continue
    if (nowMinutes >= from && nowMinutes < to) return item
  }
  return null
}

/** 按本地时区取 YYYY-MM-DD */
export function dayKeyOf(date: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 本地时区下当天已过去的分钟数 */
export function minutesOfLocalDay(date: Date = new Date()): number {
  return date.getHours() * 60 + date.getMinutes()
}
