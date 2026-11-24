import {
  ulid,
  type AttachmentRef,
  type Post,
  type PostComment,
  type PostLiker,
  type PublicUser,
} from '@nenochat/shared'
import { all, one, run, type DB } from '../index'
import { now } from '../../util/clock'

export interface PostRow {
  id: string
  author_id: string
  persona_id: string | null
  content: string
  visibility: string
  like_count: number
  comment_count: number
  created_at: number
  updated_at: number
  deleted_at: number | null
}

export interface PostListRow extends PostRow {
  username: string
  display_name: string
  avatar_url: string | null
  bio: string | null
  liked: number
}

export interface CommentRow {
  id: string
  post_id: string
  author_id: string
  persona_id: string | null
  content: string
  reply_to_comment_id: string | null
  created_at: number
  updated_at: number
  deleted_at: number | null
}

export interface CommentListRow extends CommentRow {
  username: string
  display_name: string
  avatar_url: string | null
  bio: string | null
}

interface AttachmentJoinRow {
  post_id: string
  id: string
  kind: string
  filename: string
  mime: string
  size: number
  width: number | null
  height: number | null
  storage_key: string
  thumb_key: string | null
}

function publicUser(row: {
  author_id: string
  username: string
  display_name: string
  avatar_url: string | null
  bio: string | null
}): PublicUser {
  return {
    id: row.author_id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    bio: row.bio,
  }
}

export interface PersonaBrief {
  id: string
  name: string
  avatar_url: string | null
}

/** 批量取角色署名信息，避免每条动态单独查一次 */
export async function personasOf(db: DB, ids: Array<string | null>): Promise<Map<string, PersonaBrief>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  const map = new Map<string, PersonaBrief>()
  if (unique.length === 0) return map

  const placeholders = unique.map(() => '?').join(',')
  const rows = await all<PersonaBrief>(
    db,
    `SELECT id, name, avatar_url FROM ai_personas WHERE id IN (${placeholders})`,
    unique,
  )
  for (const row of rows) map.set(row.id, row)
  return map
}

/** 角色署名时用角色名与头像替换作者信息，author.id 也指向角色 */
function authorOf(
  row: { author_id: string; username: string; display_name: string; avatar_url: string | null; bio: string | null },
  persona?: PersonaBrief,
): PublicUser {
  if (!persona) return publicUser(row)
  return {
    id: persona.id,
    username: persona.name,
    displayName: persona.name,
    avatarUrl: persona.avatar_url,
    bio: null,
  }
}

/** 附件只存相对路径，客户端按当前服务器地址拼绝对 URL */
function attachmentRef(row: AttachmentJoinRow): AttachmentRef {
  return {
    id: row.id,
    kind: row.mime.startsWith('image/') ? 'image' : 'file',
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    width: row.width,
    height: row.height,
    url: `/files/${row.storage_key}`,
    thumbUrl: row.thumb_key ? `/files/${row.thumb_key}` : null,
  }
}

async function attachmentsOf(db: DB, postIds: string[]): Promise<Map<string, AttachmentRef[]>> {
  const map = new Map<string, AttachmentRef[]>()
  if (postIds.length === 0) return map
  const placeholders = postIds.map(() => '?').join(',')
  const rows = await all<AttachmentJoinRow>(
    db,
    `SELECT pa.post_id,
            a.id, a.kind, a.filename, a.mime, a.size, a.width, a.height, a.storage_key, a.thumb_key
     FROM post_attachments pa
     JOIN attachments a ON a.id = pa.attachment_id AND a.deleted_at IS NULL
     WHERE pa.post_id IN (${placeholders})
     ORDER BY pa.position ASC`,
    postIds,
  )

  for (const row of rows) {
    const list = map.get(row.post_id) ?? []
    list.push(attachmentRef(row))
    map.set(row.post_id, list)
  }
  return map
}

interface LikerJoinRow {
  post_id: string
  user_id: string
  persona_id: string
  name: string
  avatar_url: string | null
}

/** 批量取点赞人，AI 点赞用角色名署名；按点赞时间正序展示 */
export async function likersOf(db: DB, postIds: string[]): Promise<Map<string, PostLiker[]>> {
  const map = new Map<string, PostLiker[]>()
  if (postIds.length === 0) return map

  const placeholders = postIds.map(() => '?').join(',')
  const rows = await all<LikerJoinRow>(
    db,
    `SELECT l.post_id, l.user_id, l.persona_id,
            COALESCE(CASE WHEN l.persona_id <> '' THEN ap.name END, u.display_name) AS name,
            CASE WHEN l.persona_id <> '' THEN ap.avatar_url ELSE u.avatar_url END AS avatar_url
     FROM post_likes l
     JOIN users u ON u.id = l.user_id
     LEFT JOIN ai_personas ap ON ap.id = l.persona_id AND ap.owner_id = l.user_id
     WHERE l.post_id IN (${placeholders})
     ORDER BY l.created_at ASC, l.user_id ASC, l.persona_id ASC`,
    postIds,
  )

  for (const row of rows) {
    const list = map.get(row.post_id) ?? []
    list.push({
      id: row.persona_id || row.user_id,
      name: row.name,
      avatarUrl: row.avatar_url,
      personaId: row.persona_id || null,
    })
    map.set(row.post_id, list)
  }
  return map
}

export function mapPost(
  row: PostListRow,
  attachments: AttachmentRef[] = [],
  likers: PostLiker[] = [],
  persona?: PersonaBrief,
): Post {
  return {
    id: row.id,
    authorId: row.author_id,
    personaId: row.persona_id,
    content: row.content,
    visibility: row.visibility as Post['visibility'],
    likeCount: row.like_count,
    commentCount: row.comment_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    author: authorOf(row, persona),
    attachments,
    likedByMe: Boolean(row.liked),
    likers,
  }
}

/** 信息流：全服广场，按发布时间倒序，游标为上一页最后一条的 createdAt */
export async function listFeed(db: DB, userId: string, before: number | null, limit: number): Promise<Post[]> {
  const rows = before === null
    ? await all<PostListRow>(
        db,
        `SELECT p.*, u.username, u.display_name, u.avatar_url, u.bio,
                EXISTS(SELECT 1 FROM post_likes l
                        WHERE l.post_id = p.id AND l.user_id = ? AND l.persona_id = '') AS liked
         FROM posts p JOIN users u ON u.id = p.author_id
         WHERE p.deleted_at IS NULL
         ORDER BY p.created_at DESC, p.id DESC
         LIMIT ?`,
        [userId, limit],
      )
    : await all<PostListRow>(
        db,
        `SELECT p.*, u.username, u.display_name, u.avatar_url, u.bio,
                EXISTS(SELECT 1 FROM post_likes l
                        WHERE l.post_id = p.id AND l.user_id = ? AND l.persona_id = '') AS liked
         FROM posts p JOIN users u ON u.id = p.author_id
         WHERE p.deleted_at IS NULL AND p.created_at < ?
         ORDER BY p.created_at DESC, p.id DESC
         LIMIT ?`,
        [userId, before, limit],
      )

  const postIds = rows.map((r) => r.id)
  const [attachments, likers, personas] = await Promise.all([
    attachmentsOf(db, postIds),
    likersOf(db, postIds),
    personasOf(db, rows.map((r) => r.persona_id)),
  ])
  return rows.map((row) =>
    mapPost(
      row,
      attachments.get(row.id) ?? [],
      likers.get(row.id) ?? [],
      row.persona_id ? personas.get(row.persona_id) : undefined,
    ),
  )
}

export function findById(db: DB, id: string, userId: string): Promise<PostListRow | undefined> {
  return one<PostListRow>(
    db,
    `SELECT p.*, u.username, u.display_name, u.avatar_url, u.bio,
            EXISTS(SELECT 1 FROM post_likes l
                    WHERE l.post_id = p.id AND l.user_id = ? AND l.persona_id = '') AS liked
     FROM posts p JOIN users u ON u.id = p.author_id
     WHERE p.id = ? AND p.deleted_at IS NULL`,
    [userId, id],
  )
}

export async function loadOne(db: DB, id: string, userId: string): Promise<Post | null> {
  const row = await findById(db, id, userId)
  if (!row) return null
  const [attachments, likers, personas] = await Promise.all([
    attachmentsOf(db, [id]),
    likersOf(db, [id]),
    personasOf(db, row.persona_id ? [row.persona_id] : []),
  ])
  const persona = row.persona_id ? personas.get(row.persona_id) : undefined
  return mapPost(row, attachments.get(id) ?? [], likers.get(id) ?? [], persona)
}

export interface CreatePostRowInput {
  authorId: string
  personaId?: string | null
  content: string
  visibility: string
  attachmentIds: string[]
}

export async function create(db: DB, input: CreatePostRowInput): Promise<PostRow> {
  const id = ulid()
  const ts = now()

  const row = await one<PostRow>(
    db,
    `INSERT INTO posts (id, author_id, persona_id, content, visibility, like_count, comment_count,
                        created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, NULL)
     RETURNING *`,
    [id, input.authorId, input.personaId ?? null, input.content, input.visibility, ts, ts],
  )
  if (!row) throw new Error('创建动态后回读失败')

  for (const [index, attachmentId] of input.attachmentIds.entries()) {
    await run(db, 'INSERT INTO post_attachments (post_id, attachment_id, position) VALUES (?, ?, ?)', [
      id,
      attachmentId,
      index,
    ])
  }

  return row
}

export async function softDelete(db: DB, id: string, at: number): Promise<void> {
  await run(db, 'UPDATE posts SET deleted_at = ?, updated_at = ? WHERE id = ?', [at, at, id])
}

/** 点赞是幂等切换：传入目标状态而不是「反转」，多端并发点两次不会打架 */
export async function setLike(db: DB, postId: string, userId: string, liked: boolean): Promise<number> {
  const ts = now()
  // 只动用户本人的点赞，不碰自己角色点过的那几行
  const changed = liked
    ? (
        await run(
          db,
          "INSERT INTO post_likes (post_id, user_id, persona_id, created_at) VALUES (?, ?, '', ?) ON CONFLICT DO NOTHING",
          [postId, userId, ts],
        )
      ).changes
    : (
        await run(db, "DELETE FROM post_likes WHERE post_id = ? AND user_id = ? AND persona_id = ''", [
          postId,
          userId,
        ])
      ).changes

  if (changed > 0) {
    await run(
      db,
      'UPDATE posts SET like_count = (SELECT COUNT(*) FROM post_likes WHERE post_id = ?), updated_at = ? WHERE id = ?',
      [postId, ts, postId],
    )
  }

  const row = await one<{ like_count: number }>(db, 'SELECT like_count FROM posts WHERE id = ?', [postId])
  return row?.like_count ?? 0
}

/** 角色点赞：只增不减，同一角色同一条动态由 ai_moment_actions 保证只点一次 */
export async function addPersonaLike(db: DB, postId: string, userId: string, personaId: string): Promise<number> {
  const ts = now()
  const changed = (
    await run(db, 'INSERT INTO post_likes (post_id, user_id, persona_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', [
      postId,
      userId,
      personaId,
      ts,
    ])
  ).changes

  if (changed > 0) {
    await run(
      db,
      'UPDATE posts SET like_count = (SELECT COUNT(*) FROM post_likes WHERE post_id = ?), updated_at = ? WHERE id = ?',
      [postId, ts, postId],
    )
  }

  const row = await one<{ like_count: number }>(db, 'SELECT like_count FROM posts WHERE id = ?', [postId])
  return row?.like_count ?? 0
}

export async function listComments(db: DB, postId: string): Promise<PostComment[]> {
  const rows = await all<CommentListRow>(
    db,
    `SELECT c.*, u.username, u.display_name, u.avatar_url, u.bio
     FROM post_comments c JOIN users u ON u.id = c.author_id
     WHERE c.post_id = ? AND c.deleted_at IS NULL
     ORDER BY c.created_at ASC`,
    [postId],
  )

  const personas = await personasOf(db, rows.map((row) => row.persona_id))
  return rows.map((row) => ({
    id: row.id,
    postId: row.post_id,
    authorId: row.author_id,
    personaId: row.persona_id,
    content: row.content,
    replyToCommentId: row.reply_to_comment_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    author: authorOf(row, row.persona_id ? personas.get(row.persona_id) : undefined),
  }))
}

export async function createComment(
  db: DB,
  input: {
    postId: string
    authorId: string
    personaId?: string | null
    content: string
    replyToCommentId?: string | null
  },
): Promise<CommentRow> {
  const id = ulid()
  const ts = now()
  const row = await one<CommentRow>(
    db,
    `INSERT INTO post_comments
       (id, post_id, author_id, persona_id, content, reply_to_comment_id, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
     RETURNING *`,
    [
      id,
      input.postId,
      input.authorId,
      input.personaId ?? null,
      input.content,
      input.replyToCommentId ?? null,
      ts,
      ts,
    ],
  )
  if (!row) throw new Error('创建评论后回读失败')

  await run(
    db,
    'UPDATE posts SET comment_count = (SELECT COUNT(*) FROM post_comments WHERE post_id = ? AND deleted_at IS NULL), updated_at = ? WHERE id = ?',
    [input.postId, ts, input.postId],
  )

  return row
}

export function findComment(db: DB, id: string): Promise<CommentRow | undefined> {
  return one<CommentRow>(db, 'SELECT * FROM post_comments WHERE id = ? AND deleted_at IS NULL', [id])
}

export async function softDeleteComment(db: DB, id: string, at: number): Promise<void> {
  const row = await findComment(db, id)
  if (!row) return
  await run(db, 'UPDATE post_comments SET deleted_at = ?, updated_at = ? WHERE id = ?', [at, at, id])
  await run(
    db,
    'UPDATE posts SET comment_count = (SELECT COUNT(*) FROM post_comments WHERE post_id = ? AND deleted_at IS NULL) WHERE id = ?',
    [row.post_id, row.post_id],
  )
}

/* ---------------------------- 角色浏览动态用 ---------------------------- */

export interface AiPostCandidate {
  id: string
  author_id: string
  persona_id: string | null
  author_name: string
  content: string
  image_count: number
  comment_count: number
  created_at: number
}

/**
 * 角色「刷」得到的动态：只要最近发布的，太旧的翻出来评论会显得莫名其妙。
 * 作者名已经处理好角色署名的覆盖，提示词里直接用。
 */
export function listRecentForAi(db: DB, sinceTs: number, limit: number): Promise<AiPostCandidate[]> {
  return all<AiPostCandidate>(
    db,
    `SELECT p.id, p.author_id, p.persona_id, p.content, p.comment_count, p.created_at,
            COALESCE(ap.name, u.display_name) AS author_name,
            (SELECT COUNT(*) FROM post_attachments pa WHERE pa.post_id = p.id) AS image_count
     FROM posts p
     JOIN users u ON u.id = p.author_id
     LEFT JOIN ai_personas ap ON ap.id = p.persona_id
     WHERE p.deleted_at IS NULL AND p.created_at >= ?
     ORDER BY p.created_at DESC
     LIMIT ?`,
    [sinceTs, limit],
  )
}
