/** 服务端权威时间，所有实体时间戳一律来自这里 */
export function now(): number {
  return Date.now()
}

/** 生成带日期的归档目录名，如 2026-11-16 */
export function dateKey(ts: number = Date.now()): string {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}
