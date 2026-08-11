/**
 * QQ 网关状态机测试
 *
 * 用假 WebSocket 驱动 Hello → Identify → READY → 心跳 → 断线 → Resume 全流程，
 * 断言发出去的 payload 与 seq 跟踪。这里的顺序和字段错了会表现为"连上就断"，
 * 而真实联调时很难定位，所以用测试钉住。
 */
import { describe, expect, mock, test } from 'bun:test'

/** 假 socket：记录发出的 payload，并允许测试主动投递下行消息 */
class FakeSocket {
  static OPEN = 1
  static instances: FakeSocket[] = []

  readyState = FakeSocket.OPEN
  sent: Array<Record<string, unknown>> = []
  closed = false
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>()

  constructor(public url: string) {
    FakeSocket.instances.push(this)
  }

  on(event: string, cb: (...args: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? []
    list.push(cb)
    this.listeners.set(event, list)
  }

  removeAllListeners(): void {
    this.listeners.clear()
  }

  close(): void {
    this.closed = true
  }

  send(data: Buffer | string): void {
    this.sent.push(JSON.parse(data.toString()) as Record<string, unknown>)
  }

  /** 模拟服务端下行 */
  emitMessage(payload: unknown): void {
    for (const cb of this.listeners.get('message') ?? []) cb(Buffer.from(JSON.stringify(payload)))
  }

  emitOpen(): void {
    for (const cb of this.listeners.get('open') ?? []) cb()
  }

  emitClose(code = 1006): void {
    this.readyState = 3
    for (const cb of this.listeners.get('close') ?? []) cb(code, Buffer.from(''))
  }
}

mock.module('ws', () => ({ default: FakeSocket }))

const { QQGatewayClient } = await import('./qq-gateway-client')

/** 等一个微任务轮次，让内部的 await 链推进 */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

interface Harness {
  client: InstanceType<typeof QQGatewayClient>
  socket: () => FakeSocket
  events: Array<{ name: string; data: unknown }>
  statuses: string[]
}

async function setup(): Promise<Harness> {
  FakeSocket.instances = []
  const events: Array<{ name: string; data: unknown }> = []
  const statuses: string[] = []

  const client = new QQGatewayClient({
    getAuthorization: async () => 'QQBot test-token',
    getGatewayUrl: async () => 'wss://example.invalid/websocket',
    intents: 1 << 25,
    logPrefix: '[test]',
    callbacks: {
      onEvent: (name, data) => events.push({ name, data }),
      onStatus: (status) => statuses.push(status),
    },
  })

  await client.start()
  await tick()
  return {
    client,
    socket: () => FakeSocket.instances[FakeSocket.instances.length - 1]!,
    events,
    statuses,
  }
}

describe('QQ 网关握手', () => {
  test('收到 Hello 后发 Identify，携带 token / intents / shard', async () => {
    const h = await setup()
    h.socket().emitOpen()
    h.socket().emitMessage({ op: 10, d: { heartbeat_interval: 40_000 } })
    await tick()

    const identify = h.socket().sent.find((p) => p.op === 2)
    expect(identify).toBeDefined()
    expect(identify!.d).toEqual({
      token: 'QQBot test-token',
      intents: 1 << 25,
      shard: [0, 1],
      properties: {},
    })
    h.client.stop()
  })

  test('READY 后状态变为 connected，且 READY 不会当成业务事件抛出', async () => {
    const h = await setup()
    h.socket().emitMessage({ op: 10, d: { heartbeat_interval: 40_000 } })
    await tick()
    h.socket().emitMessage({ op: 0, s: 1, t: 'READY', d: { session_id: 'sess-1' } })

    expect(h.statuses).toContain('connected')
    expect(h.events.map((e) => e.name)).not.toContain('READY')
    expect(h.client.connected).toBe(true)
    h.client.stop()
  })

  test('业务事件透传给回调', async () => {
    const h = await setup()
    h.socket().emitMessage({ op: 10, d: { heartbeat_interval: 40_000 } })
    await tick()
    h.socket().emitMessage({ op: 0, s: 1, t: 'READY', d: { session_id: 'sess-1' } })
    h.socket().emitMessage({
      op: 0,
      s: 2,
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: { id: 'msg-1', content: 'hi' },
    })

    expect(h.events).toHaveLength(1)
    expect(h.events[0]!.name).toBe('GROUP_AT_MESSAGE_CREATE')
    expect((h.events[0]!.data as { id: string }).id).toBe('msg-1')
    h.client.stop()
  })
})

describe('心跳与 seq 跟踪', () => {
  test('心跳带最新 seq；未收到任何事件时为 null', async () => {
    const h = await setup()
    h.socket().emitMessage({ op: 10, d: { heartbeat_interval: 5 } })
    await tick()
    await new Promise((resolve) => setTimeout(resolve, 12))

    const firstHeartbeat = h.socket().sent.find((p) => p.op === 1)
    expect(firstHeartbeat).toBeDefined()
    expect(firstHeartbeat!.d).toBeNull()
    h.client.stop()
  })

  test('收到带 s 的事件后，心跳改用该 seq', async () => {
    const h = await setup()
    h.socket().emitMessage({ op: 10, d: { heartbeat_interval: 5 } })
    await tick()
    h.socket().emitMessage({ op: 0, s: 42, t: 'READY', d: { session_id: 'sess-1' } })
    // 心跳 ACK 让下一次心跳能继续发
    h.socket().emitMessage({ op: 11 })
    await new Promise((resolve) => setTimeout(resolve, 20))

    const heartbeats = h.socket().sent.filter((p) => p.op === 1)
    expect(heartbeats.length).toBeGreaterThan(0)
    expect(heartbeats[heartbeats.length - 1]!.d).toBe(42)
    h.client.stop()
  })
})

describe('断线恢复', () => {
  test('已有 session_id 时重连走 Resume 而不是 Identify', async () => {
    const h = await setup()
    h.socket().emitMessage({ op: 10, d: { heartbeat_interval: 40_000 } })
    await tick()
    h.socket().emitMessage({ op: 0, s: 7, t: 'READY', d: { session_id: 'sess-abc' } })

    // 断开后等退避重连（初始退避 2s）
    h.socket().emitClose()
    await new Promise((resolve) => setTimeout(resolve, 2_200))
    const reconnected = h.socket()
    reconnected.emitMessage({ op: 10, d: { heartbeat_interval: 40_000 } })
    await tick()

    const resume = reconnected.sent.find((p) => p.op === 6)
    expect(resume).toBeDefined()
    expect(resume!.d).toEqual({ token: 'QQBot test-token', session_id: 'sess-abc', seq: 7 })
    expect(reconnected.sent.find((p) => p.op === 2)).toBeUndefined()
    h.client.stop()
  }, 10_000)

  test('Invalid Session 会清掉 session，重连时退回 Identify', async () => {
    const h = await setup()
    h.socket().emitMessage({ op: 10, d: { heartbeat_interval: 40_000 } })
    await tick()
    h.socket().emitMessage({ op: 0, s: 7, t: 'READY', d: { session_id: 'sess-abc' } })
    h.socket().emitMessage({ op: 9 })

    await new Promise((resolve) => setTimeout(resolve, 2_200))
    const reconnected = h.socket()
    reconnected.emitMessage({ op: 10, d: { heartbeat_interval: 40_000 } })
    await tick()

    expect(reconnected.sent.find((p) => p.op === 2)).toBeDefined()
    expect(reconnected.sent.find((p) => p.op === 6)).toBeUndefined()
    h.client.stop()
  }, 10_000)

  test('stop() 之后不再重连', async () => {
    const h = await setup()
    const before = FakeSocket.instances.length
    h.client.stop()
    h.socket().emitClose()
    await new Promise((resolve) => setTimeout(resolve, 2_200))

    expect(FakeSocket.instances.length).toBe(before)
  }, 10_000)
})
