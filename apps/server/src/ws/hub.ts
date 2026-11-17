import type { ServerEventName } from '@nenochat/shared'

/**
 * WS 广播抽象。服务层只依赖这个接口，
 * 未接入 WS 时（例如单元测试）会自动降级为 no-op。
 */
export interface RealtimeHub {
  sendToUser(userId: string, event: ServerEventName, payload: unknown, seq?: number): void
  sendToUsers(userIds: string[], event: ServerEventName, payload: unknown, seq?: number): void
  sendToConversation(
    conversationId: string,
    event: ServerEventName,
    payload: unknown,
    seq?: number,
    exceptUserId?: string,
  ): void
  isOnline(userId: string): boolean
  onlineUserIds(): string[]
}

const noopHub: RealtimeHub = {
  sendToUser: () => {},
  sendToUsers: () => {},
  sendToConversation: () => {},
  isOnline: () => false,
  onlineUserIds: () => [],
}

let current: RealtimeHub = noopHub

export function setHub(hub: RealtimeHub): void {
  current = hub
}

export function hub(): RealtimeHub {
  return current
}
