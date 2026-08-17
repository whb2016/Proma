import { describe, expect, test } from 'bun:test'
import type { ChatMessage, ProviderType } from '@proma/shared'
import { AnthropicAdapter } from './anthropic-adapter.ts'
import type { StreamRequestInput } from './types.ts'
import { setPromaVersion } from './user-agent.ts'

function buildRequest(provider: ProviderType, apiKey = 'test-key') {
  const adapter = new AnthropicAdapter(provider)
  const baseUrl = provider === 'xiaomi-token-plan'
    ? 'https://token-plan-cn.xiaomimimo.com/anthropic'
    : provider === 'qwen-token-plan'
      ? 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages'
      : provider === 'zhipu-coding-team'
      ? 'https://open.bigmodel.cn/api/anthropic'
      : 'https://api.xiaomimimo.com/anthropic'

  return adapter.buildStreamRequest({
    baseUrl,
    apiKey,
    modelId: 'mimo-v2.5-pro',
    history: [],
    userMessage: 'ping',
    readImageAttachments: () => [],
  })
}

describe('AnthropicAdapter headers', () => {
  test('xiaomi API uses api-key authentication', () => {
    const request = buildRequest('xiaomi')

    expect(request.headers['api-key']).toBe('test-key')
    expect(request.headers.Authorization).toBeUndefined()
    expect(request.headers['User-Agent']).toBeUndefined()
  })

  test('xiaomi token plan keeps bearer authentication with Proma User-Agent', () => {
    setPromaVersion('9.9.9')

    const request = buildRequest('xiaomi-token-plan')

    expect(request.headers.Authorization).toBe('Bearer test-key')
    expect(request.headers['User-Agent']).toBe('Proma/9.9.9 (+https://github.com/ErlichLiu/Proma)')
    expect(request.headers['api-key']).toBeUndefined()
  })

  test('qwen token plan uses the complete Anthropic endpoint with bearer authentication and Proma User-Agent', () => {
    setPromaVersion('9.9.9')

    const request = buildRequest('qwen-token-plan')

    expect(request.url).toBe('https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages')
    expect(request.headers.Authorization).toBe('Bearer test-key')
    expect(request.headers['User-Agent']).toBe('Proma/9.9.9 (+https://github.com/ErlichLiu/Proma)')
    expect(request.headers['x-api-key']).toBeUndefined()
  })

  test('zhipu team plan uses apiKey from JSON for model calls', () => {
    setPromaVersion('9.9.9')

    const request = buildRequest(
      'zhipu-coding-team',
      '{"apiKey":"model-key","organization":"org","project":"proj"}',
    )

    expect(request.headers.Authorization).toBe('Bearer model-key')
    expect(request.headers['User-Agent']).toBe('Proma/9.9.9 (+https://github.com/ErlichLiu/Proma)')
    expect(request.headers['api-key']).toBeUndefined()
  })
})

// ===== Prompt Caching =====

/** 请求体里我们关心的部分 */
interface ParsedBody {
  system?: string | Array<Record<string, unknown>>
  metadata?: Record<string, unknown>
  messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>
}

function buildBody(provider: ProviderType, overrides: Partial<StreamRequestInput> = {}): ParsedBody {
  const adapter = new AnthropicAdapter(provider)
  const request = adapter.buildStreamRequest({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'test-key',
    modelId: 'claude-opus-4-6',
    history: [],
    userMessage: '第二个问题',
    systemMessage: '你是助手',
    readImageAttachments: () => [],
    ...overrides,
  })
  return JSON.parse(request.body) as ParsedBody
}

/** 一轮已完成的问答，用来让请求进入「有历史可复用」的状态 */
const ONE_TURN_HISTORY: ChatMessage[] = [
  { id: '1', role: 'user', content: '第一个问题', createdAt: 1 },
  { id: '2', role: 'assistant', content: '第一个回答', createdAt: 2 },
]

/** 取最后一条消息的最后一个内容块 */
function lastBlockOf(body: ParsedBody): Record<string, unknown> | undefined {
  const last = body.messages[body.messages.length - 1]
  if (!last || typeof last.content === 'string') return undefined
  return last.content[last.content.length - 1]
}

describe('AnthropicAdapter prompt caching', () => {
  test('多轮对话在 system 和消息末尾各打一个断点', () => {
    const body = buildBody('anthropic', { history: ONE_TURN_HISTORY })

    expect(body.system).toEqual([
      { type: 'text', text: '你是助手', cache_control: { type: 'ephemeral' } },
    ])
    expect(lastBlockOf(body)).toEqual({
      type: 'text',
      text: '第二个问题',
      cache_control: { type: 'ephemeral' },
    })
  })

  test('首轮单条消息不打消息断点（没有下一轮来读，只会白付写入费）', () => {
    const body = buildBody('anthropic')

    // system 仍然打断点：它跨对话不变，命中率高
    expect(Array.isArray(body.system)).toBe(true)
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0]!.content).toBe('第二个问题')
  })

  test('断点落在工具续接消息之后，而不是当前用户消息上', () => {
    const body = buildBody('anthropic', {
      continuationMessages: [
        { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'search', arguments: {} }] },
        { role: 'tool', results: [{ toolCallId: 't1', content: '搜索结果' }] },
      ],
    })

    expect(lastBlockOf(body)).toEqual({
      type: 'tool_result',
      tool_use_id: 't1',
      content: '搜索结果',
      is_error: false,
      cache_control: { type: 'ephemeral' },
    })
    // 当前用户消息不应被顺手包成块
    expect(body.messages[0]!.content).toBe('第二个问题')
  })

  test('白名单外的兼容渠道完全不发 cache_control', () => {
    const body = buildBody('minimax', { history: ONE_TURN_HISTORY })

    expect(body.system).toBe('你是助手')
    expect(JSON.stringify(body)).not.toContain('cache_control')
  })
})

describe('AnthropicAdapter metadata', () => {
  test('给了 userId 就写进 metadata.user_id', () => {
    const body = buildBody('anthropic', { userId: 'user_abc123__session_conv-1' })

    expect(body.metadata).toEqual({ user_id: 'user_abc123__session_conv-1' })
  })

  test('没给 userId 时不带 metadata 字段（翻译、视觉中转等场景）', () => {
    const body = buildBody('anthropic')

    expect(body.metadata).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('metadata')
  })

  test('兼容渠道同样发 metadata（不认这个字段的端点会忽略）', () => {
    const body = buildBody('minimax', { userId: 'user_abc123__session_conv-1' })

    expect(body.metadata).toEqual({ user_id: 'user_abc123__session_conv-1' })
  })
})
