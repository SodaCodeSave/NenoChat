import type { DB } from '../index'
import { now } from '../../util/clock'

export interface BilibiliSummaryRow {
  owner_id: string
  video_id: string
  title: string | null
  summary: string
  model: string | null
  created_at: number
  updated_at: number
}

export function findSummary(
  db: DB,
  ownerId: string,
  videoId: string,
): BilibiliSummaryRow | undefined {
  return db
    .prepare('SELECT * FROM bilibili_video_summaries WHERE owner_id = ? AND video_id = ?')
    .get(ownerId, videoId) as BilibiliSummaryRow | undefined
}

export function saveSummary(
  db: DB,
  input: {
    ownerId: string
    videoId: string
    title?: string | null
    summary: string
    model?: string | null
  },
): BilibiliSummaryRow {
  const ts = now()
  db.prepare(
    `INSERT INTO bilibili_video_summaries
       (owner_id, video_id, title, summary, model, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_id, video_id) DO UPDATE SET
       title = excluded.title,
       summary = excluded.summary,
       model = excluded.model,
       updated_at = excluded.updated_at`,
  ).run(
    input.ownerId,
    input.videoId,
    input.title ?? null,
    input.summary,
    input.model ?? null,
    ts,
    ts,
  )
  const row = findSummary(db, input.ownerId, input.videoId)
  if (!row) throw new Error('保存视频总结后回读失败')
  return row
}
