/**
 * QQ 开放平台 WebSocket 网关客户端
 *
 * 协议流程（op 值见 QQ_OPCODE）：
 *   建连 → op10 Hello（取 d.heartbeat_interval 毫秒）
 *        → 发 op2 Identify（token / intents / shard）
 *        → 收 READY（存 session_id）
 *        → 按周期发 op1 心跳（d = 已收到的最新 s，首次 null），服务端回 op11
 *        → op0 Dispatch 推送事件（带 t 事件名、s 序号）
 *   断线 → 发 op6 Resume（token / session_id / seq），网关补发该 seq 之后的事件，
 *          完成后下发 RESUMED；无法 Resume 时（op9 或缺 session）退回 Identify
 *   op7 Reconnect → 服务端要求重连
 *
 * 用仓库已有的 ws 依赖（doubao-asr-service.ts 已有先例），不额外引 SDK。
 */
import WebSocket from 'ws'
import { QQ_EVENT, QQ_OPCODE } from '@proma/shared'
import { redactSensitiveLogValue } from './bridge-log-redaction'

/** 网关下行/上行负载 */
interface GatewayPayload {
  op: number
  d?: unknown
  s?: number
  t?: string
}

export interface QQGatewayCallbacks {
  /** 收到业务事件（op0 Dispatch，READY/RESUMED 除外） */
  onEvent: (eventName: string, data: unknown) => void
  /** 鉴权完成（首次 Identify 成功） */
  onReady?: (data: unknown) => void
  /** 断线补发完成 */
  onResumed?: () => void
  /** 连接状态变化，供 Bridge 更新 UI 状态 */
  onStatus?: (status: 'connecting' | 'connected' | 'disconnected', errorMessage?: string) => void
}

const INITIAL_BACKOFF_MS = 2_000
const MAX_BACKOFF_MS = 60_000
/** 连续多少次心跳没等到 ACK 就判定连接已死 */
const MAX_MISSED_ACKS = 2

export class QQGatewayClient {
  private ws: WebSocket | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  /** 最新收到的事件序号，心跳与 Resume 都要用 */
  private lastSeq: number | null = null
  private sessionId: string | null = null
  private missedAcks = 0
  private backoffMs = INITIAL_BACKOFF_MS
  /** 主动 stop() 后不再自动重连 */
  private stopped = false

  constructor(
    private readonly options: {
      /** 每次连接前现取，保证不用过期 token */
      getAuthorization: () => Promise<string>
      /** 取 wss 地址；内部会在每次重连时重新解析 */
      getGatewayUrl: () => Promise<string>
      intents: number
      /** 日志前缀，如 `[QQ Bridge:研发助手]` */
      logPrefix: string
      callbacks: QQGatewayCallbacks
    },
  ) {}

  /** 当前是否已鉴权并可收发 */
  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.sessionId !== null
  }

  async start(): Promise<void> {
    this.stopped = false
    await this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    this.closeSocket()
    this.sessionId = null
    this.lastSeq = null
    this.options.callbacks.onStatus?.('disconnected')
  }

  private log(message: string): void {
    console.log(`${this.options.logPrefix} ${message}`)
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private closeSocket(): void {
    if (!this.ws) return
    const socket = this.ws
    this.ws = null
    // 先摘掉监听再关，避免 close 回调又触发一次重连
    socket.removeAllListeners()
    try {
      socket.close()
    } catch {
      /* 已经断开则忽略 */
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    this.options.callbacks.onStatus?.('connecting')

    let url: string
    try {
      url = await this.options.getGatewayUrl()
    } catch (error) {
      this.scheduleReconnect(`获取网关地址失败: ${this.describe(error)}`)
      return
    }

    const socket = new WebSocket(url)
    this.ws = socket

    socket.on('open', () => this.log('WebSocket 已连接，等待 Hello'))
    socket.on('message', (raw) => {
      void this.handleMessage(raw.toString())
    })
    socket.on('error', (error) => {
      // error 之后必然跟 close，这里只记录，重连交给 close 处理
      console.error(`${this.options.logPrefix} WebSocket 错误:`, redactSensitiveLogValue(error))
    })
    socket.on('close', (code, reason) => {
      this.clearTimers()
      this.ws = null
      if (this.stopped) return
      this.scheduleReconnect(`连接关闭 (code ${code}${reason?.length ? ` ${reason.toString()}` : ''})`)
    })
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped || this.reconnectTimer) return
    this.closeSocket()
    this.options.callbacks.onStatus?.('disconnected', reason)
    const delay = this.backoffMs
    this.log(`${reason}，${Math.round(delay / 1000)}s 后重连`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS)
  }

  private send(payload: GatewayPayload): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    // 该 ws 类型只接受二进制负载，与 doubao-asr-service 的用法一致
    this.ws.send(Buffer.from(JSON.stringify(payload), 'utf8'))
  }

  private async handleMessage(raw: string): Promise<void> {
    let payload: GatewayPayload
    try {
      payload = JSON.parse(raw) as GatewayPayload
    } catch (error) {
      console.error(`${this.options.logPrefix} 无法解析网关消息:`, redactSensitiveLogValue(error))
      return
    }

    // 只有 Dispatch 带 s；心跳与 Resume 都以它为基准
    if (typeof payload.s === 'number') this.lastSeq = payload.s

    switch (payload.op) {
      case QQ_OPCODE.HELLO: {
        const interval = (payload.d as { heartbeat_interval?: number } | undefined)?.heartbeat_interval
        await this.onHello(typeof interval === 'number' && interval > 0 ? interval : 30_000)
        break
      }
      case QQ_OPCODE.HEARTBEAT_ACK:
        this.missedAcks = 0
        break
      case QQ_OPCODE.DISPATCH:
        this.onDispatch(payload)
        break
      case QQ_OPCODE.RECONNECT:
        this.log('服务端要求重连')
        this.scheduleReconnect('服务端下发 Reconnect')
        break
      case QQ_OPCODE.INVALID_SESSION:
        // session 失效：清掉 session_id，下次走完整 Identify 而不是 Resume
        this.log('Invalid Session，将以全新会话重新鉴权')
        this.sessionId = null
        this.lastSeq = null
        this.scheduleReconnect('Invalid Session')
        break
      default:
        break
    }
  }

  private async onHello(intervalMs: number): Promise<void> {
    let authorization: string
    try {
      authorization = await this.options.getAuthorization()
    } catch (error) {
      this.scheduleReconnect(`取 access token 失败: ${this.describe(error)}`)
      return
    }

    // 有 session_id 就续，没有就重新鉴权
    if (this.sessionId && this.lastSeq !== null) {
      this.log(`发送 Resume（seq ${this.lastSeq}）`)
      this.send({
        op: QQ_OPCODE.RESUME,
        d: { token: authorization, session_id: this.sessionId, seq: this.lastSeq },
      })
    } else {
      this.log('发送 Identify')
      this.send({
        op: QQ_OPCODE.IDENTIFY,
        d: {
          token: authorization,
          intents: this.options.intents,
          // 单实例不分片
          shard: [0, 1],
          properties: {},
        },
      })
    }

    this.startHeartbeat(intervalMs)
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.missedAcks = 0
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return
      if (this.missedAcks >= MAX_MISSED_ACKS) {
        // 连接卡死时 close 事件可能一直不来，主动断开触发重连
        this.log(`连续 ${this.missedAcks} 次心跳未收到 ACK，主动重连`)
        this.scheduleReconnect('心跳无响应')
        return
      }
      this.missedAcks++
      this.send({ op: QQ_OPCODE.HEARTBEAT, d: this.lastSeq })
    }, intervalMs)
  }

  private onDispatch(payload: GatewayPayload): void {
    const eventName = payload.t ?? ''

    if (eventName === QQ_EVENT.READY) {
      const sessionId = (payload.d as { session_id?: string } | undefined)?.session_id
      if (sessionId) this.sessionId = sessionId
      this.backoffMs = INITIAL_BACKOFF_MS
      this.log('鉴权成功（READY）')
      this.options.callbacks.onStatus?.('connected')
      this.options.callbacks.onReady?.(payload.d)
      return
    }

    if (eventName === QQ_EVENT.RESUMED) {
      this.backoffMs = INITIAL_BACKOFF_MS
      this.log('断线事件已补发完毕（RESUMED）')
      this.options.callbacks.onStatus?.('connected')
      this.options.callbacks.onResumed?.()
      return
    }

    if (!eventName) return
    try {
      this.options.callbacks.onEvent(eventName, payload.d)
    } catch (error) {
      console.error(`${this.options.logPrefix} 处理事件 ${eventName} 失败:`, redactSensitiveLogValue(error))
    }
  }
}
