/**
 * QQ REST 客户端负载结构测试
 *
 * 这里断言的是"发出去的 body 长什么样" —— 字段名或 msg_type 错了，平台通常只回一个
 * 笼统的错误码，很难从联调现场反推，所以用测试钉住。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { QQApiClient } from './qq-api-client'

interface CapturedRequest {
  url: string
  method?: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

const originalFetch = globalThis.fetch
let captured: CapturedRequest[] = []

/** 用固定响应替换 fetch，并记录请求 */
function stubFetch(response: unknown): void {
  captured = []
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    captured.push({
      url: String(input),
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    })
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(response),
      headers: new Headers(),
    } as Response
  }) as typeof fetch
}

function createClient(sandbox = false): QQApiClient {
  return new QQApiClient({ sandbox, getAuthorization: async () => 'QQBot fake-token' })
}

beforeEach(() => stubFetch({}))
afterEach(() => { globalThis.fetch = originalFetch })

describe('请求地址与鉴权', () => {
  test('生产环境用 api.sgroup.qq.com，沙箱用 sandbox 前缀', async () => {
    await createClient(false).getGatewayUrl().catch(() => {})
    expect(captured[0]!.url).toBe('https://api.sgroup.qq.com/gateway')

    stubFetch({ url: 'wss://x' })
    await createClient(true).getGatewayUrl()
    expect(captured[0]!.url).toBe('https://sandbox.api.sgroup.qq.com/gateway')
  })

  test('带 Authorization: QQBot {token}', async () => {
    stubFetch({ url: 'wss://x' })
    await createClient().getGatewayUrl()
    expect(captured[0]!.headers.Authorization).toBe('QQBot fake-token')
  })

  test('网关未返回 url 时抛错，而不是返回空串', async () => {
    stubFetch({})
    await expect(createClient().getGatewayUrl()).rejects.toThrow('未返回 url')
  })
})

describe('发送回复', () => {
  test('群聊与单聊走不同端点', async () => {
    const client = createClient()
    await client.sendMarkdown('group', 'GROUP_1', 'hi', 'msg-1', 1)
    expect(captured[0]!.url).toBe('https://api.sgroup.qq.com/v2/groups/GROUP_1/messages')

    stubFetch({})
    await client.sendMarkdown('c2c', 'USER_1', 'hi', 'msg-1', 1)
    expect(captured[0]!.url).toBe('https://api.sgroup.qq.com/v2/users/USER_1/messages')
  })

  test('以 markdown 发送：msg_type 2 + markdown.content，并带 msg_id/msg_seq', async () => {
    await createClient().sendMarkdown('group', 'G', '## 标题\n\n- 项目', 'msg-9', 3)

    expect(captured[0]!.body).toEqual({
      content: '',
      msg_type: 2,
      markdown: { content: '## 标题\n\n- 项目' },
      msg_id: 'msg-9',
      msg_seq: 3,
    })
  })

  test('openid 会被 URL 编码，避免特殊字符破坏路径', async () => {
    await createClient().sendMarkdown('c2c', 'a/b?c', 'hi', 'm', 1)
    expect(captured[0]!.url).toContain('/v2/users/a%2Fb%3Fc/messages')
  })
})

describe('富媒体两步发送', () => {
  test('先上传取 file_info，再发 msg_type 7', async () => {
    // 第一次调用返回 file_info，第二次是发消息
    let call = 0
    captured = []
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      captured.push({
        url: String(input),
        method: init?.method,
        headers: {},
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      })
      call++
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(call === 1 ? { file_info: 'FILE_INFO_X' } : {}),
        headers: new Headers(),
      } as Response
    }) as typeof fetch

    await createClient().sendMedia('group', 'G', Buffer.from('hello'), true, 'msg-1', 2)

    expect(captured).toHaveLength(2)
    // 上传：走 /files，file_type 1=图片，base64 负载，srv_send_msg 必须为 false
    expect(captured[0]!.url).toBe('https://api.sgroup.qq.com/v2/groups/G/files')
    expect(captured[0]!.body).toEqual({
      file_type: 1,
      file_data: Buffer.from('hello').toString('base64'),
      srv_send_msg: false,
    })
    // 发送：msg_type 7 + media.file_info
    expect(captured[1]!.url).toBe('https://api.sgroup.qq.com/v2/groups/G/messages')
    expect(captured[1]!.body).toEqual({
      content: '',
      msg_type: 7,
      media: { file_info: 'FILE_INFO_X' },
      msg_id: 'msg-1',
      msg_seq: 2,
    })
  })

  test('非图片用 file_type 4（通用文件），与图片的 1 区分开', async () => {
    stubFetch({ file_info: 'X' })
    await createClient().sendMedia('c2c', 'U', Buffer.from('x'), false, 'm', 1)
    expect(captured[0]!.body.file_type).toBe(4)
  })

  test('上传未返回 file_info 时抛错，不会发出残缺的消息', async () => {
    stubFetch({})
    await expect(
      createClient().sendMedia('group', 'G', Buffer.from('x'), true, 'm', 1),
    ).rejects.toThrow('未返回 file_info')
    expect(captured).toHaveLength(1)
  })
})

describe('业务错误处理', () => {
  test('HTTP 200 但 code 非 0 也视为失败', async () => {
    stubFetch({ code: 11244, message: '权限不足' })
    await expect(createClient().sendMarkdown('group', 'G', 'hi', 'm', 1)).rejects.toThrow('权限不足')
  })
})
