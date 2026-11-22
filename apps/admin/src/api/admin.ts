import { http } from './http'

/** 与服务端 admin 路由响应一一对应的类型 */

export interface AdminUser {
  id: string
  username: string
  displayName: string
  avatarUrl: string | null
  bio?: string | null
  status: 'active' | 'disabled'
  isAdmin: boolean
  isBot?: boolean
  lastSeenAt: number | null
  createdAt: number
}

export interface AdminUserListItem extends AdminUser {
  deviceCount: number
}

export interface AdminDevice {
  id: string
  name: string
  platform: string
  appVersion: string | null
  lastActiveAt: number | null
}

export interface AdminUserDetail {
  user: AdminUser
  devices: AdminDevice[]
  conversationCount: number
  messageCount: number
  postCount: number
  sessionCount: number
  aiBalance: number
}

export interface Paged<T> {
  items: T[]
  total: number
}

export interface AdminStats {
  users: { total: number; disabled: number; bots: number; active24h: number }
  conversations: { total: number; direct: number; group: number; ai: number }
  messages: { total: number; last24h: number }
  posts: { total: number }
  storage: { attachments: number; bytes: number }
  ai: { tokens24h: number; tokens7d: number }
  recentUsers: AdminUser[]
}

export interface AdminInvite {
  code: string
  createdBy: string | null
  createdByName: string | null
  maxUses: number
  uses: number
  expiresAt: number | null
  createdAt: number
}

export interface AdminConversation {
  id: string
  type: 'direct' | 'group' | 'ai'
  name: string | null
  avatarUrl: string | null
  ownerId: string | null
  lastMessageAt: number | null
  createdAt: number
  messageCount: number
  memberCount: number
  lastActivityAt: number | null
}

export interface AdminMessage {
  id: string
  conversationId: string
  senderId: string | null
  senderName?: string | null
  senderType: 'user' | 'ai' | 'system'
  type: string
  content: string
  seq: number
  createdAt: number
  deletedAt: number | null
}

export interface AdminPost {
  id: string
  authorId: string
  authorName: string | null
  personaId: string | null
  content: string
  visibility: string
  likeCount: number
  commentCount: number
  createdAt: number
}

export interface AdminComment {
  id: string
  postId: string
  authorId: string
  author?: { id: string; username: string; displayName: string; avatarUrl?: string | null }
  personaId?: string | null
  content: string
  replyToCommentId?: string | null
  createdAt: number
  deletedAt?: number | null
}

export interface AdminFile {
  id: string
  ownerId: string
  ownerName: string | null
  kind: string
  filename: string
  mime: string
  size: number
  sha256: string
  url: string | null
  createdAt: number
  deleted: boolean
}

export interface AdminSettings {
  serverName: string
  registrationMode: 'open' | 'invite' | 'closed'
  env: { serverName: string; registrationMode: string }
  version: string
  buildStamp: string
  minClientVersion: string
  maxUploadMb: number
}

export interface AdminAiUsage {
  window: string
  totals: { calls: number; promptTokens: number; completionTokens: number; cachedTokens: number }
  byKind: Array<{ kind: string; calls: number; promptTokens: number; completionTokens: number }>
  byModel: Array<{ model: string | null; calls: number; promptTokens: number; completionTokens: number }>
  byUser: Array<{
    userId: string
    displayName: string | null
    calls: number
    promptTokens: number
    completionTokens: number
  }>
}

export interface AdminAiProviderModel {
  model: string
  enabled: boolean
  priceInput: number | null
  priceOutput: number | null
  priceCached: number | null
}

export interface AdminAiProvider {
  id: string
  name: string
  baseUrl: string
  apiKeyMasked?: string | null
  model: string
  visionModel?: string | null
  contextWindow?: number | null
  models?: AdminAiProviderModel[]
  temperature: number
  maxTokens: number
  isDefault: boolean
  balance?: string | null
  balanceCurrency?: string | null
  balanceCheckedAt?: number | null
}

export interface AdminBalanceItem {
  userId: string
  username: string
  displayName: string
  balance: number
  updatedAt: number | null
}

export interface AdminAuditEntry {
  id: string
  actorId: string
  actorName: string | null
  action: string
  targetType: string
  targetId: string | null
  detail: unknown
  createdAt: number
}

export interface GcResult {
  scannedFiles: number
  referencedKeys: number
  removedRows: number
  removedFiles: number
  freedBytes: number
}

/* ------------------------------ 端点包装 ------------------------------ */

export const adminApi = {
  stats: () => http.get<AdminStats>('/admin/stats'),

  users: {
    list: (query: { q?: string; status?: string; page: number }) =>
      http.get<Paged<AdminUserListItem>>('/admin/users', { query }),
    detail: (id: string) => http.get<AdminUserDetail>(`/admin/users/${id}`),
    devices: (id: string) => http.get<{ devices: AdminDevice[] }>(`/admin/users/${id}/devices`),
    removeDevice: (id: string, deviceId: string) =>
      http.delete<{ ok: boolean }>(`/admin/users/${id}/devices/${deviceId}`),
    disable: (id: string) => http.post<{ user: AdminUser }>(`/admin/users/${id}/disable`),
    enable: (id: string) => http.post<{ user: AdminUser }>(`/admin/users/${id}/enable`),
    resetPassword: (id: string, password: string) =>
      http.post<{ ok: boolean }>(`/admin/users/${id}/reset-password`, { password }),
    setAdmin: (id: string, isAdmin: boolean) =>
      http.post<{ user: AdminUser }>(`/admin/users/${id}/set-admin`, { isAdmin }),
    delete: (id: string) => http.delete<{ ok: boolean }>(`/admin/users/${id}`),
  },

  invites: {
    list: () => http.get<{ invites: AdminInvite[] }>('/admin/invites'),
    create: (input: { maxUses: number; expiresInDays?: number | null }) =>
      http.post<{ invite: AdminInvite }>('/admin/invites', input),
    remove: (code: string) => http.delete<{ ok: boolean }>(`/admin/invites/${encodeURIComponent(code)}`),
  },

  conversations: {
    list: (query: { type?: string; q?: string; page: number }) =>
      http.get<Paged<AdminConversation>>('/admin/conversations', { query }),
    messages: (id: string, beforeSeq?: number) =>
      http.get<{ items: AdminMessage[]; conversation: AdminConversation | null }>(
        `/admin/conversations/${id}/messages`,
        { query: { beforeSeq } },
      ),
    recallMessage: (id: string) => http.delete<{ message: AdminMessage }>(`/admin/messages/${id}`),
  },

  posts: {
    list: (query: { q?: string; page: number }) => http.get<Paged<AdminPost>>('/admin/posts', { query }),
    comments: (postId: string) =>
      http.get<{ comments: AdminComment[] }>(`/admin/posts/${postId}/comments`),
    remove: (id: string) => http.delete<{ ok: boolean }>(`/admin/posts/${id}`),
    removeComment: (id: string) => http.delete<{ ok: boolean }>(`/admin/comments/${id}`),
  },

  files: {
    list: (query: { kind?: string; q?: string; page: number; includeDeleted?: boolean }) =>
      http.get<Paged<AdminFile>>('/admin/files', { query }),
    remove: (id: string) => http.delete<{ ok: boolean }>(`/admin/files/${id}`),
    gc: () => http.post<{ result: GcResult }>('/admin/files/gc'),
  },

  settings: {
    get: () => http.get<AdminSettings>('/admin/settings'),
    update: (patch: { serverName?: string; registrationMode?: string }) =>
      http.patch<{ serverName: string; registrationMode: string }>('/admin/settings', patch),
  },

  aiUsage: (window: '24h' | '7d' | '30d') => http.get<AdminAiUsage>('/admin/ai/usage', { query: { window } }),

  aiConfig: {
    providers: () =>
      http.get<{ sharedMode: boolean; providers: AdminAiProvider[] }>('/admin/ai/providers'),
    setSharedMode: (enabled: boolean) =>
      http.patch<{ sharedMode: boolean }>('/admin/ai/shared-mode', { enabled }),
    createProvider: (body: Record<string, unknown>) =>
      http.post<{ provider: AdminAiProvider }>('/admin/ai/providers', body),
    updateProvider: (id: string, body: Record<string, unknown>) =>
      http.patch<{ provider: AdminAiProvider }>(`/admin/ai/providers/${id}`, body),
    removeProvider: (id: string) => http.delete<{ ok: boolean }>(`/admin/ai/providers/${id}`),
    previewModels: (input: { baseUrl: string; apiKey?: string }) =>
      http.post<{ models: string[] }>('/admin/ai/providers/models', input),
    providerModels: (id: string) =>
      http.get<{ models: string[] }>(`/admin/ai/providers/${id}/models`),
    testProvider: (input: { baseUrl: string; apiKey: string; model: string }) =>
      http.post<{ ok: boolean; sample: string }>('/admin/ai/providers/test', input),
    testProviderStored: (id: string, input: { baseUrl?: string; model?: string }) =>
      http.post<{ ok: boolean; sample: string }>(`/admin/ai/providers/${id}/test`, input),
    providerBalance: (id: string) =>
      http.post<{ provider: AdminAiProvider }>(`/admin/ai/providers/${id}/balance`, {}),
    balances: (page: number) => http.get<Paged<AdminBalanceItem>>('/admin/ai/balances', { query: { page } }),
    adjustBalance: (userId: string, delta: number) =>
      http.post<{ userId: string; balance: number }>(`/admin/ai/balances/${userId}`, { delta }),
  },

  audit: (page: number) => http.get<Paged<AdminAuditEntry>>('/admin/audit', { query: { page } }),
}

/* ------------------------------ 认证端点 ------------------------------ */

export interface AuthTokens {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

export const authApi = {
  login: (input: { username: string; password: string; device: { id: string; name: string; platform: string } }) =>
    http.post<{ user: AdminUser; tokens: AuthTokens }>('/auth/login', input, { auth: false }),
  me: () =>
    http.get<{ user: AdminUser | null; settings: unknown; notificationSettings: unknown }>('/auth/me'),
  logout: (refreshToken: string) => http.post<{ ok: boolean }>('/auth/logout', { refreshToken }),
}
