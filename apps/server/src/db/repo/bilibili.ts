import { one, type Executor } from '../index'
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

export async function findSummary(
  db: Executor,
  ownerId: string,
  videoId: string,
): Promise<BilibiliSummaryRow | undefined> {
  return one<BilibiliSummaryRow>(
    db,
    'SELECT * FROM bilibili_video_summaries WHERE owner_id = ? AND video_id = ?',
    [ownerId, videoId],
  )
}

export async function saveSummary(
  db: Executor,
  input: {
    ownerId: string
    videoId: string
    title?: string | null
    summary: string
    model?: string | null
  },
): Promise<BilibiliSummaryRow> {
  const ts = now()
  const row = await one<BilibiliSummaryRow>(
    db,
    `INSERT INTO bilibili_video_summaries
       (owner_id, video_id, title, summary, model, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_id, video_id) DO UPDATE SET
       title = excluded.title,
       summary = excluded.summary,
       model = excluded.model,
       updated_at = excluded.updated_at
     RETURNING *`,
    [
      input.ownerId,
      input.videoId,
      input.title ?? null,
      input.summary,
      input.model ?? null,
      ts,
      ts,
    ],
  )
  if (!row) throw new Error('保存视频总结后回读失败')
  return row
}
