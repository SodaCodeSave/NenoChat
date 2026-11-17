import {
  WS_HEARTBEAT_MS,
  type ClientEventName,
  type ClientEventPayloads,
  type ServerEventName,
  type ServerEventPayloads,
  type WsFrame,
} from '@nenochat/shared'

export type ConnStatus = 'idle' | 'connecting' | 'catching-up' | 'live' | 'offline'

export interface WsOptions {
  url: string
  deviceId: string
  /** 每次（重）连都重新取 token，避免用过期凭证握手 */
  getToken: () => Promise<string | null>
  /** 每次（重）连都重新取游标，保证断线期间的消息能补齐 */
  getCursor: () => Promise<number>
  onStatus: (status: ConnStatus) => void
  onFatal: (reason: string) => void
}

type AnyHandler = (payload: unknown, seq?: number) => void

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const BACKOFF_STEPS = [500, 1000, 2000, 4000, 8000, 15000, 30000]

/**
 * WebSocket 客户端：负责握手、心跳、请求响应配对与指数退避重连。
 * 业务逻辑不在这里，全部交给 dispatcher 注册的处理器。
 */
class WsClient {
  private socket: WebSocket | null = null
  private options: WsOptions | null = null
  private handlers = new Map<string, Set<AnyHandler>>()
  private pending = new Map<string, PendingRequest>()
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private manualClose = false
  private requestSeq = 0
  private status: ConnStatus = 'idle'

  configure(options: WsOptions): void {
    this.options = options
  }

  getStatus(): ConnStatus {
    return this.status
  }

  private setStatus(status: ConnStatus): void {
    if (this.status === status) return
    this.status = status
    this.options?.onStatus(status)
  }

  on<E extends ServerEventName>(event: E, handler: (payload: ServerEventPayloads[E], seq?: number) => void): () => void {
    const wrapped: AnyHandler = (payload, seq) => handler(payload as ServerEventPayloads[E], seq)
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(wrapped)
    return () => {
      set?.delete(wrapped)
    }
  }

  private dispatch(event: string, payload: unknown, seq?: number): void {
    const set = this.handlers.get(event)
    if (!set) return
    for (const handler of set) {
      try {
        handler(payload, seq)
      } catch (e) {
        console.error('[ws] 处理器异常', event, e)
      }
    }
  }

  async connect(): Promise<void> {
    if (!this.options) throw new Error('WS 尚未配置')
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return
    }

    this.manualClose = false
    this.clearReconnect()
    this.setStatus('connecting')

    const token = await this.options.getToken()
    if (!token) {
      this.options.onFatal('缺少登录凭证')
      return
    }
    const cursor = await this.options.getCursor()

    const socket = new WebSocket(this.options.url)
    this.socket = socket

    socket.onopen = () => {
      this.attempt = 0
      socket.send(
        JSON.stringify({
          t: 'req',
          id: this.nextId(),
          e: 'auth',
          d: { token, deviceId: this.options?.deviceId ?? '', cursor, resume: cursor > 0 },
        } satisfies WsFrame),
      )
    }

    socket.onmessage = (raw) => {
      let frame: WsFrame
      try {
        frame = JSON.parse(String(raw.data)) as WsFrame
      } catch {
        return
      }

      if (frame.t === 'res') {
        const waiter = this.pending.get(frame.id)
        if (!waiter) return
        clearTimeout(waiter.timer)
        this.pending.delete(frame.id)
        if (frame.ok) waiter.resolve(frame.d)
        else waiter.reject(new Error(frame.err.message))
        return
      }

      if (frame.t === 'evt') {
        if (frame.e === 'auth.ok') this.setStatus('catching-up')
        if (frame.e === 'auth.err') {
          this.options?.onFatal(frame.d as unknown as string)
          return
        }
        // 追平批次里 hasMore=false 表示已落地到实时态
        if (frame.e === 'sync.batch') {
          const payload = frame.d as { hasMore: boolean }
          if (!payload.hasMore) this.setStatus('live')
        }
        this.dispatch(frame.e, frame.d, frame.seq)
        return
      }

      if (frame.t === 'ack') return
    }

    socket.onerror = () => {
      // 具体原因由 onclose 统一处理
    }

    socket.onclose = (event) => {
      this.cleanup()
      this.rejectAllPending(new Error('连接已断开'))

      if (this.manualClose) {
        this.setStatus('idle')
        return
      }
      if (event.code === 4401) {
        this.options?.onFatal('登录状态已失效')
        return
      }
      this.setStatus('offline')
      this.scheduleReconnect()
    }

    this.startHeartbeat()
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeat = setInterval(() => {
      if (this.socket?.readyState !== WebSocket.OPEN) return
      try {
        this.socket.send(
          JSON.stringify({ t: 'req', id: this.nextId(), e: 'ping', d: { ts: Date.now() } } satisfies WsFrame),
        )
      } catch {
        /* 忽略，交给 onclose 处理 */
      }
    }, WS_HEARTBEAT_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
  }

  private scheduleReconnect(): void {
    const step = BACKOFF_STEPS[Math.min(this.attempt, BACKOFF_STEPS.length - 1)] ?? 30000
    const jitter = step * 0.2 * (Math.random() * 2 - 1)
    this.attempt += 1
    this.clearReconnect()
    this.reconnectTimer = setTimeout(() => {
      void this.connect()
    }, step + jitter)
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private cleanup(): void {
    this.stopHeartbeat()
    this.socket = null
  }

  private rejectAllPending(error: Error): void {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
  }

  private nextId(): string {
    this.requestSeq += 1
    return `r${this.requestSeq}`
  }

  /** 发送一条请求并等待对应响应；离线时立即失败，由 outbox 决定是否重试 */
  request<E extends ClientEventName>(
    event: E,
    payload: ClientEventPayloads[E],
    timeoutMs = 10000,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket = this.socket
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reject(new Error('OFFLINE'))
        return
      }
      const id = this.nextId()
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('请求超时'))
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, timer })
      try {
        socket.send(JSON.stringify({ t: 'req', id, e: event, d: payload } satisfies WsFrame))
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(e instanceof Error ? e : new Error('发送失败'))
      }
    })
  }

  /** 只发不等，用于 typing 这类高频且可丢的事件 */
  emit<E extends ClientEventName>(event: E, payload: ClientEventPayloads[E]): void {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    try {
      socket.send(JSON.stringify({ t: 'req', id: this.nextId(), e: event, d: payload } satisfies WsFrame))
    } catch {
      /* 忽略 */
    }
  }

  isOnline(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  close(): void {
    this.manualClose = true
    this.clearReconnect()
    this.rejectAllPending(new Error('主动断开'))
    if (this.socket) {
      this.socket.close()
    }
    this.cleanup()
    this.setStatus('idle')
  }
}

export const wsClient = new WsClient()
