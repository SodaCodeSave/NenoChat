import type { LinkPreview } from '@nenochat/shared'
import { one, type Executor } from '../index'
import { now } from '../../util/clock'

export interface LinkPreviewRow {
  url_hash: string
  url: string
  kind: string
  title: string | null
  description: string | null
  image: string | null
  site_name: string | null
  author: string | null
  video_id: string | null
  fetched_at: number
}

export async function findLinkPreview(db: Executor, urlHash: string): Promise<LinkPreviewRow | undefined> {
  return one<LinkPreviewRow>(db, 'SELECT * FROM link_previews WHERE url_hash = ?', [urlHash])
}

export async function saveLinkPreview(
  db: Executor,
  input: Omit<LinkPreview, 'hasSummary' | 'fetchedAt'> & { urlHash: string },
): Promise<LinkPreviewRow> {
  const ts = now()
  const row = await one<LinkPreviewRow>(
    db,
    `INSERT INTO link_previews
       (url_hash, url, kind, title, description, image, site_name, author, video_id, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(url_hash) DO UPDATE SET
       kind = excluded.kind,
       title = excluded.title,
       description = excluded.description,
       image = excluded.image,
       site_name = excluded.site_name,
       author = excluded.author,
       video_id = excluded.video_id,
       fetched_at = excluded.fetched_at
     RETURNING *`,
    [
      input.urlHash,
      input.url,
      input.kind,
      input.title,
      input.description,
      input.image,
      input.siteName,
      input.author ?? null,
      input.videoId ?? null,
      ts,
    ],
  )
  if (!row) throw new Error('保存链接卡片后回读失败')
  return row
}

export function mapLinkPreview(row: LinkPreviewRow): LinkPreview {
  return {
    url: row.url,
    kind: row.kind === 'bilibili' ? 'bilibili' : 'website',
    title: row.title,
    description: row.description,
    image: row.image,
    siteName: row.site_name,
    author: row.author,
    videoId: row.video_id,
    fetchedAt: row.fetched_at,
  }
}
