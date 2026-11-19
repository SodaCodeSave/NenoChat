import {
  API_PREFIX,
  type ChangeRecord,
  type Contact,
  type Conversation,
  type Member,
  type Message,
  type NotificationSettings,
  type PublicUser,
  type ServerInfo,
  type User,
  type UserSettings,
} from '@nenochat/shared'
import { http } from './http'

const p = (path: string): string => `${API_PREFIX}${path}`

export interface AuthSessionResponse {
  user: User
  tokens: { accessToken: string; refreshToken: string; expiresIn: number }
}

export const authApi = {
  register: (body: unknown) =>
    http.post<AuthSessionResponse>(p('/auth/register'), body, { auth: false }),
  login: (body: unknown) => http.post<AuthSessionResponse>(p('/auth/login'), body, { auth: false }),
  /** 一体化版免密登录：握手令牌由客户端进程注入，不走用户名密码 */
  local: (body: unknown, localToken: string) =>
    http.post<AuthSessionResponse>(p('/auth/local'), body, {
      auth: false,
      headers: { 'x-local-token': localToken },
    }),
  // 刷新本身不能再走 401 自动刷新，否则会递归等待自己
  refresh: (refreshToken: string, deviceId: string) =>
    http.post<AuthSessionResponse>(
      p('/auth/refresh'),
      { refreshToken, device: { id: deviceId } },
      { auth: false },
    ),
  logout: (refreshToken?: string, allDevices?: boolean) =>
    http.post<{ ok: boolean }>(p('/auth/logout'), { refreshToken, allDevices }),
  me: () =>
    http.get<{
      user: User | null
      settings: UserSettings | null
      notificationSettings: NotificationSettings | null
    }>(p('/auth/me')),
  devices: () => http.get<{ devices: unknown[] }>(p('/auth/devices')),
}

export const serverApi = {
  info: () => http.get<ServerInfo>(p('/server/info'), { auth: false }),
}

export interface ConversationSummary extends Conversation {
  pinnedAt?: number | null
  notificationLevel?: string | null
  memberCount?: number
  unreadCount?: number
  mentionCount?: number
  myLastReadSeq?: number
  partnerId?: string | null
  partnerName?: string | null
  partnerAvatarUrl?: string | null
}

export const conversationApi = {
  list: () => http.get<{ conversations: ConversationSummary[] }>(p('/conversations')),
  create: (body: unknown) =>
    http.post<{ conversation: Conversation; members?: Member[] }>(p('/conversations'), body),
  detail: (id: string) =>
    http.get<{
      conversation: Conversation
      me: Member
      members: Array<Member & { user: PublicUser | null }>
    }>(p(`/conversations/${id}`)),
  update: (id: string, body: unknown) =>
    http.patch<{ conversation: Conversation }>(p(`/conversations/${id}`), body),
  pin: (id: string, pinned: boolean) => http.post<{ member: Member }>(p(`/conversations/${id}/pin`), { pinned }),
  addMembers: (id: string, userIds: string[]) =>
    http.post<{ members: Member[] }>(p(`/conversations/${id}/members`), { userIds }),
  updateMember: (id: string, userId: string, body: unknown) =>
    http.patch<{ member: Member }>(p(`/conversations/${id}/members/${userId}`), body),
  removeMember: (id: string, userId: string) =>
    http.delete<{ ok: boolean }>(p(`/conversations/${id}/members/${userId}`)),
  transfer: (id: string, userId: string) =>
    http.post<{ previous: Member; next: Member }>(p(`/conversations/${id}/transfer`), { userId }),
  deleteForMe: (id: string) => http.delete<{ ok: boolean }>(p(`/conversations/${id}/for-me`)),
  dissolve: (id: string) => http.delete<{ ok: boolean }>(p(`/conversations/${id}`)),
}

export interface ContactListResponse {
  friends: Contact[]
  incoming: Contact[]
  outgoing: Contact[]
}

export const contactApi = {
  list: () => http.get<ContactListResponse>(p('/contacts')),
  request: (userId: string, message?: string) =>
    http.post<{ contact: Contact }>(p('/contacts/requests'), { userId, message }),
  accept: (userId: string) =>
    http.post<{ contact: Contact; requester: Contact }>(p(`/contacts/requests/${userId}/accept`)),
  decline: (userId: string) =>
    http.post<{ ok: boolean }>(p(`/contacts/requests/${userId}/decline`)),
  addPersona: (personaId: string) =>
    http.post<{ contact: Contact }>(p('/contacts/personas'), { personaId }),
  setAlias: (userId: string, alias: string | null) =>
    http.patch<{ contact: Contact }>(p(`/contacts/${userId}`), { alias }),
  remove: (userId: string) => http.delete<{ ok: boolean }>(p(`/contacts/${userId}`)),
}

export interface SendMessageBody {
  conversationId: string
  clientNonce: string
  type?: string
  content: string
  meta?: unknown
  replyToId?: string | null
}

export const messageApi = {
  page: (
    conversationId: string,
    query: { before?: number; after?: number; limit?: number },
  ) =>
    http.get<{ messages: Message[]; hasMore: boolean }>(p(`/conversations/${conversationId}/messages`), {
      query,
    }),
  around: (conversationId: string, messageId: string) =>
    http.get<{ messages: Message[]; hasMore: boolean }>(
      p(`/conversations/${conversationId}/messages/around/${messageId}`),
    ),
  send: (body: SendMessageBody) =>
    http.post<{ message: Message; duplicated: boolean }>(p('/messages'), body),
  edit: (messageId: string, content: string) =>
    http.patch<{ message: Message }>(p(`/messages/${messageId}`), { content }),
  recall: (messageId: string) => http.delete<{ message: Message }>(p(`/messages/${messageId}`)),
  pin: (messageId: string, pinned: boolean) =>
    http.post<{ message: Message }>(p(`/messages/${messageId}/pin`), { pinned }),
  pins: (conversationId: string) =>
    http.get<{ messages: Message[] }>(p(`/conversations/${conversationId}/pins`)),
  markRead: (conversationId: string, messageSeq: number, messageId?: string) =>
    http.post<{ advanced: boolean; lastReadSeq: number }>(p(`/conversations/${conversationId}/read`), {
      messageSeq,
      messageId,
    }),
}

export const syncApi = {
  changes: (since: number, limit = 500) =>
    http.get<
      | { reset: true; reason: string; snapshotCursor: number }
      | { changes: ChangeRecord[]; nextCursor: number; hasMore: boolean }
    >(p('/sync/changes'), { query: { since, limit } }),
  head: () => http.get<{ cursor: number }>(p('/sync/head')),
}

export const notificationSettingsApi = {
  update: (patch: Partial<NotificationSettings>) =>
    http.patch<{ notificationSettings: NotificationSettings }>(p('/settings/notifications'), patch),
}

export const userApi = {
  me: () => http.get<{ user: User }>(p('/users/me')),
  updateProfile: (body: unknown) => http.patch<{ user: User }>(p('/users/me'), body),
  changePassword: (body: unknown) => http.post<{ ok: boolean }>(p('/users/me/password'), body),
  search: (q: string) => http.get<{ users: PublicUser[] }>(p('/users/search'), { query: { q } }),
  get: (id: string) => http.get<{ user: PublicUser }>(p(`/users/${id}`)),
}
