import { describe, expect, test } from 'bun:test'
import { formatAgentUserId } from './agent-request-metadata'

const SEED = 'C:\\Users\\tester\\.proma'

describe('formatAgentUserId', () => {
  test('中文用户名会被哈希成纯 ASCII，且格式对齐 user_<hash>__session_<id>', () => {
    const id = formatAgentUserId('王小明', SEED, 'sess-1')

    expect(id).toMatch(/^user_[0-9a-f]{16}__session_sess-1$/)
    // 不得泄露原始用户名，也不得出现非 ASCII
    expect(id).not.toContain('王小明')
    expect(/^[\x20-\x7e]+$/.test(id)).toBe(true)
  })

  test('同一用户名恒定映射到同一哈希，不同用户名不同', () => {
    const a = formatAgentUserId('王小明', SEED, 'sess-1')
    const b = formatAgentUserId('王小明', SEED, 'sess-2')
    const c = formatAgentUserId('李小红', SEED, 'sess-1')

    // 用户维度稳定：换会话不改哈希，只改 session 段
    expect(a.split('__session_')[0]).toBe(b.split('__session_')[0])
    expect(a.split('__session_')[0]).not.toBe(c.split('__session_')[0])
  })

  test('用户名前后空白不影响结果', () => {
    expect(formatAgentUserId('  王小明  ', SEED, 's')).toBe(formatAgentUserId('王小明', SEED, 's'))
  })

  test('用户名为空时退化为兜底种子，且与同名用户不撞哈希', () => {
    const empty = formatAgentUserId('', SEED, 's')
    const blank = formatAgentUserId('   ', SEED, 's')
    const undef = formatAgentUserId(undefined, SEED, 's')

    expect(empty).toBe(undef)
    expect(blank).toBe(undef)
    expect(empty).toMatch(/^user_[0-9a-f]{16}__session_s$/)

    // 前缀区分来源：用户名恰好等于兜底种子时也不应撞出同一个哈希
    expect(formatAgentUserId(SEED, SEED, 's')).not.toBe(empty)
  })

  test('不同兜底种子（不同机器/dev 与正式版）得到不同哈希', () => {
    const dev = formatAgentUserId(undefined, 'C:\\Users\\tester\\.proma-dev', 's')
    const prod = formatAgentUserId(undefined, 'C:\\Users\\tester\\.proma', 's')

    expect(dev).not.toBe(prod)
  })
})
