import { describe, expect, test } from 'bun:test'
import {
  MsgSeqAllocator,
  QQ_TEXT_CHUNK_SIZE,
  chunkReply,
  decodeQQChatId,
  encodeQQChatId,
  maxRepliesFor,
} from './qq-target'

describe('chatId 编解码', () => {
  test('群聊与单聊往返一致', () => {
    for (const target of [
      { kind: 'group' as const, openid: 'GROUP_OPENID_123' },
      { kind: 'c2c' as const, openid: 'USER_OPENID_456' },
    ]) {
      expect(decodeQQChatId(encodeQQChatId(target))).toEqual(target)
    }
  })

  test('openid 里含冒号也能正确解析（只按第一个冒号切）', () => {
    const target = { kind: 'c2c' as const, openid: 'a:b:c' }
    expect(decodeQQChatId(encodeQQChatId(target))).toEqual(target)
  })

  test('非法输入返回 undefined，不会误当成群聊', () => {
    for (const bad of ['', 'group', 'group:', ':abc', 'unknown:abc']) {
      expect(decodeQQChatId(bad)).toBeUndefined()
    }
  })
})

describe('被动回复分段', () => {
  test('分段数不超过平台配额（群 4、单聊 2）', () => {
    // 平台上限群 5 / 单聊 4。群聊留 1 条给附件或错误提示；
    // 单聊还要先发一条「正在输入」，所以正文只剩 2 条。
    expect(maxRepliesFor('group')).toBe(4)
    expect(maxRepliesFor('c2c')).toBe(2)

    const long = 'x'.repeat(QQ_TEXT_CHUNK_SIZE * 10)
    expect(chunkReply(long, 'group')).toHaveLength(4)
    expect(chunkReply(long, 'c2c')).toHaveLength(2)
  })

  test('短文本只发一段且内容不变', () => {
    expect(chunkReply('hello', 'group')).toEqual(['hello'])
  })

  test('恰好等于单段上限时不产生空的第二段', () => {
    const exact = 'y'.repeat(QQ_TEXT_CHUNK_SIZE)
    const chunks = chunkReply(exact, 'group')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe(exact)
  })

  test('超出配额时截断并明确告知，而不是静默丢内容', () => {
    const long = 'z'.repeat(QQ_TEXT_CHUNK_SIZE * 6)
    const chunks = chunkReply(long, 'c2c')

    expect(chunks).toHaveLength(2)
    const omitted = QQ_TEXT_CHUNK_SIZE * 6 - QQ_TEXT_CHUNK_SIZE * 2
    expect(chunks[1]).toContain(`剩余 ${omitted} 字未发送`)
  })

  test('未超配额时不追加截断提示', () => {
    const chunks = chunkReply('a'.repeat(QQ_TEXT_CHUNK_SIZE * 2), 'group')
    expect(chunks).toHaveLength(2)
    expect(chunks.join('')).not.toContain('未发送')
  })

  test('空文本不产生任何消息', () => {
    expect(chunkReply('', 'group')).toEqual([])
  })
})

describe('MsgSeqAllocator', () => {
  test('同一 msg_id 递增，从 1 开始', () => {
    const allocator = new MsgSeqAllocator()
    expect(allocator.next('msg-1')).toBe(1)
    expect(allocator.next('msg-1')).toBe(2)
    expect(allocator.next('msg-1')).toBe(3)
  })

  test('不同 msg_id 各自独立计数', () => {
    const allocator = new MsgSeqAllocator()
    expect(allocator.next('a')).toBe(1)
    expect(allocator.next('b')).toBe(1)
    expect(allocator.next('a')).toBe(2)
  })

  test('超过 TTL 的 msg_id 被淘汰，重新从 1 开始', () => {
    const allocator = new MsgSeqAllocator(1000, 100)
    expect(allocator.next('old', 0)).toBe(1)
    expect(allocator.next('old', 500)).toBe(2)
    // 距上次触碰超过 1000ms
    expect(allocator.next('old', 2000)).toBe(1)
  })

  test('条数超上限时淘汰最旧的，不会无界增长', () => {
    const allocator = new MsgSeqAllocator(60_000, 3)
    for (const id of ['m1', 'm2', 'm3', 'm4', 'm5']) {
      allocator.next(id, 0)
    }
    // 最旧的已被挤出，重新计数为 1
    expect(allocator.next('m1', 0)).toBe(1)
    // 最近的仍保留，继续递增
    expect(allocator.next('m5', 0)).toBe(2)
  })
})
