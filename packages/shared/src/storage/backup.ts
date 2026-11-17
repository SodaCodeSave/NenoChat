import { z } from 'zod'
import type { BackupFile, BackupRow, BackupServer, BackupSummary, BackupValue } from './types'

export const BACKUP_FORMAT = 'nenochat.backup'
export const BACKUP_VERSION = 1

/**
 * 备份允许包含的表与列。
 * 导入时只按这份白名单取列，避免被篡改的备份文件往库里塞未知字段或执行任意 SQL。
 */
export const BACKUP_TABLES: Record<string, readonly string[]> = {
  users: ['server_id', 'id', 'username', 'display_name', 'avatar_url', 'bio', 'last_seen_at', 'updated_at'],
  conversations: [
    'server_id',
    'id',
    'type',
    'name',
    'avatar_url',
    'owner_id',
    'announcement',
    'ai_persona_id',
    'last_message_id',
    'last_message_at',
    'message_count',
    'dm_key',
    'partner_id',
    'partner_name',
    'partner_avatar_url',
    'pinned_at',
    'notification_level',
    'unread_count',
    'mention_count',
    'my_last_read_seq',
    'member_count',
    'created_at',
    'updated_at',
    'deleted_at',
  ],
  members: [
    'server_id',
    'conversation_id',
    'user_id',
    'role',
    'nickname',
    'allow',
    'deny',
    'mute_until',
    'joined_at',
    'left_at',
    'updated_at',
    'notification_level',
  ],
  messages: [
    'server_id',
    'id',
    'conversation_id',
    'sender_id',
    'sender_type',
    'type',
    'content',
    'meta',
    'reply_to_id',
    'seq',
    'client_nonce',
    'ai_generation_id',
    'ai_index',
    'pinned_at',
    'edited_at',
    'deleted_at',
    'created_at',
    'updated_at',
    'local_status',
    'local_error',
  ],
  read_cursors: ['server_id', 'conversation_id', 'last_read_seq', 'updated_at'],
  contacts: ['server_id', 'contact_user_id', 'alias', 'relation', 'request_message', 'updated_at'],
  posts: [
    'server_id',
    'id',
    'author_id',
    'content',
    'visibility',
    'like_count',
    'comment_count',
    'liked_by_me',
    'attachments',
    'created_at',
    'updated_at',
    'deleted_at',
  ],
  post_comments: [
    'server_id',
    'id',
    'post_id',
    'author_id',
    'content',
    'reply_to_comment_id',
    'created_at',
    'updated_at',
    'deleted_at',
  ],
  sticker_packs: ['server_id', 'id', 'name', 'kind', 'position', 'updated_at'],
  stickers: ['server_id', 'id', 'pack_id', 'kind', 'value', 'url', 'keywords', 'position', 'updated_at'],
  ai_providers: [
    'server_id',
    'id',
    'name',
    'base_url',
    'model',
    'key_location',
    'api_key_masked',
    'temperature',
    'max_tokens',
    'is_default',
    'updated_at',
  ],
  ai_personas: [
    'server_id',
    'id',
    'name',
    'avatar_url',
    'system_prompt',
    'greeting',
    'provider_id',
    'model_override',
    'reply_style',
    'proactive',
    'updated_at',
    'interests',
    'card',
    'card_url',
    'card_filename',
    'in_contacts',
    'proactive_enabled',
    'last_proactive_at',
    'proactive_mode',
  ],
  ai_memory_summaries: [
    'server_id',
    'id',
    'conversation_id',
    'from_seq',
    'to_seq',
    'summary',
    'superseded_by',
    'created_at',
  ],
  ai_memory_facts: [
    'server_id',
    'id',
    'conversation_id',
    'subject',
    'key',
    'value',
    'confidence',
    'status',
    'updated_at',
  ],
  notifications: [
    'server_id',
    'id',
    'type',
    'title',
    'body',
    'conversation_id',
    'message_id',
    'post_id',
    'is_read',
    'created_at',
  ],
  app_settings: ['server_id', 'key', 'value', 'updated_at'],
  drafts: ['server_id', 'conversation_id', 'content', 'updated_at'],
}

/** 允许随备份带走的客户端本地偏好 */
export const BACKUP_PREFERENCE_KEYS = [
  'nenochat.theme',
  'nenochat.accent',
  'nenochat.attachmentCache.policy',
] as const

const BackupValueSchema = z.union([z.string(), z.number(), z.null()])

const BackupFileSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.number().int().positive(),
  exportedAt: z.number().int().nonnegative(),
  appVersion: z.string().optional(),
  server: z.object({
    id: z.string(),
    name: z.string(),
    baseUrl: z.string(),
  }),
  tables: z.record(z.string(), z.array(z.record(z.string(), BackupValueSchema))),
  preferences: z.record(z.string(), z.string()).optional(),
})

function toBackupValue(value: unknown): BackupValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value ? 1 : 0
  return null
}

/** 只保留白名单内的列，并把值收敛成 JSON 可安全往返的标量 */
export function sanitizeBackupRows(table: string, rows: unknown): BackupRow[] {
  const columns = BACKUP_TABLES[table]
  if (!columns || !Array.isArray(rows)) return []

  const result: BackupRow[] = []
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const source = raw as Record<string, unknown>
    const row: BackupRow = {}
    for (const column of columns) {
      if (!(column in source)) continue
      row[column] = toBackupValue(source[column])
    }
    if (Object.keys(row).length > 0) result.push(row)
  }
  return result
}

/** 清洗整份表数据，未知表直接丢弃 */
export function sanitizeBackupTables(raw: unknown): Record<string, BackupRow[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const tables: Record<string, BackupRow[]> = {}
  for (const [table, rows] of Object.entries(raw as Record<string, unknown>)) {
    if (!(table in BACKUP_TABLES)) continue
    const sanitized = sanitizeBackupRows(table, rows)
    if (sanitized.length > 0) tables[table] = sanitized
  }
  return tables
}

export interface BuildBackupInput {
  server: BackupServer
  tables: Record<string, unknown>
  preferences?: Record<string, string>
  appVersion?: string
  now?: number
}

/** 生成备份对象；行数据先过一遍白名单，保证导出的文件能被同版本安全导入 */
export function buildBackup(input: BuildBackupInput): BackupFile {
  const preferences: Record<string, string> = {}
  for (const key of BACKUP_PREFERENCE_KEYS) {
    const value = input.preferences?.[key]
    if (typeof value === 'string') preferences[key] = value
  }

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: input.now ?? Date.now(),
    appVersion: input.appVersion,
    server: {
      id: input.server.id,
      name: input.server.name,
      baseUrl: input.server.baseUrl,
    },
    tables: sanitizeBackupTables(input.tables),
    preferences: Object.keys(preferences).length > 0 ? preferences : undefined,
  }
}

export type ParseBackupResult =
  | { ok: true; backup: BackupFile }
  | { ok: false; error: string }

/** 解析并校验备份文件；任何一步失败都返回可展示的中文原因 */
export function parseBackup(text: string): ParseBackupResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: '文件不是有效的 JSON' }
  }

  const parsed = BackupFileSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, error: '不是有效的 NenoChat 备份文件' }
  }
  if (parsed.data.version > BACKUP_VERSION) {
    return { ok: false, error: '备份文件来自更高版本的客户端，请先升级应用' }
  }

  const tables = sanitizeBackupTables(parsed.data.tables)
  if (Object.keys(tables).length === 0) {
    return { ok: false, error: '备份文件里没有可恢复的数据' }
  }

  const preferences: Record<string, string> = {}
  for (const key of BACKUP_PREFERENCE_KEYS) {
    const value = parsed.data.preferences?.[key]
    if (typeof value === 'string') preferences[key] = value
  }

  return {
    ok: true,
    backup: {
      format: BACKUP_FORMAT,
      version: parsed.data.version,
      exportedAt: parsed.data.exportedAt,
      appVersion: parsed.data.appVersion,
      server: parsed.data.server,
      tables,
      preferences: Object.keys(preferences).length > 0 ? preferences : undefined,
    },
  }
}

/** 把备份里的 server_id 统一改写成目标服务器，支持把旧备份恢复到当前服务器 */
export function retargetBackup(backup: BackupFile, targetServerId: string): BackupFile {
  const tables: Record<string, BackupRow[]> = {}
  for (const [table, rows] of Object.entries(backup.tables)) {
    const columns = BACKUP_TABLES[table] ?? []
    if (!columns.includes('server_id')) {
      tables[table] = rows
      continue
    }
    tables[table] = rows.map((row) => ({ ...row, server_id: targetServerId }))
  }
  return { ...backup, tables }
}

export function summarizeBackup(backup: BackupFile): BackupSummary {
  const count = (table: string): number => backup.tables[table]?.length ?? 0
  const totalRows = Object.values(backup.tables).reduce((sum, rows) => sum + rows.length, 0)
  return {
    messages: count('messages'),
    conversations: count('conversations'),
    members: count('members'),
    users: count('users'),
    notifications: count('notifications'),
    drafts: count('drafts'),
    totalRows,
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 生成适合文件系统的备份文件名，例如 NenoChat-备份-20261117-1530.json */
export function backupFileName(serverName: string, at = new Date()): string {
  const safe =
    serverName.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'NenoChat'
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}`
  return `${safe}-备份-${stamp}.json`
}
