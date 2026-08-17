import { describe, expect, test } from 'bun:test'
import type { SystemPromptConfig } from '@proma/shared'
import { resolveSystemMessage } from './system-prompt-atoms'

function buildConfig(appendDateTimeAndUserName: boolean): SystemPromptConfig {
  return {
    prompts: [
      {
        id: 'p1',
        name: '测试',
        content: '你是助手',
        isBuiltin: false,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    defaultPromptId: 'p1',
    appendDateTimeAndUserName,
  }
}

describe('resolveSystemMessage', () => {
  test('开启附加段时带上日期与用户名', () => {
    const message = resolveSystemMessage('p1', buildConfig(true), '张三')

    expect(message).toStartWith('你是助手')
    expect(message).toContain('当前日期: ')
    expect(message).toContain('用户名: 张三')
  })

  /**
   * 这条是缓存回归护栏：附加段一旦带上时分，分钟一跳整段系统提示词就变，
   * Anthropic 的提示词缓存（前缀匹配，system 排在 messages 之前）会全部失效，
   * 而且任何消息侧的断点都救不回来。详见 anthropic-adapter.ts 的 PROMPT_CACHE_PROVIDERS。
   */
  test('附加段不能包含时分，否则提示词缓存每分钟失效一次', () => {
    const message = resolveSystemMessage('p1', buildConfig(true), '张三')

    expect(message).not.toMatch(/\d{1,2}:\d{2}/)
  })

  test('关闭附加段时原样返回提示词内容', () => {
    const message = resolveSystemMessage('p1', buildConfig(false), '张三')

    expect(message).toBe('你是助手')
  })

  test('promptId 不存在时返回 undefined', () => {
    expect(resolveSystemMessage('nope', buildConfig(true), '张三')).toBeUndefined()
  })
})
