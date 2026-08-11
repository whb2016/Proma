/**
 * QQ 会话标识与被动回复配额
 *
 * `BridgeCommandHandler` 用单个 chatId 字符串标识会话，而 QQ 需要区分群聊与单聊
 * （两者的发送端点和 openid 都不同），所以把二者编码进 chatId：
 *   群聊 `group:{group_openid}` / 单聊 `c2c:{user_openid}`
 *
 * 另外集中管理 msg_seq 与分段上限 —— QQ 的被动回复有硬配额：
 *   群聊 5 分钟内同一 msg_id 最多 5 条，单聊 60 分钟内最多 4 条。
 * 每一段文本都消耗一次配额，所以分段数必须受控，不能照抄微信那种"按长度切到底"。
 */

export type QQTargetKind = 'group' | 'c2c'

export interface QQTarget {
  kind: QQTargetKind
  openid: string
}

/** 编码为 handler 用的 chatId */
export function encodeQQChatId(target: QQTarget): string {
  return `${target.kind}:${target.openid}`
}

/** 解析 chatId；格式不合法返回 undefined */
export function decodeQQChatId(chatId: string): QQTarget | undefined {
  const sep = chatId.indexOf(':')
  if (sep <= 0) return undefined
  const kind = chatId.slice(0, sep)
  const openid = chatId.slice(sep + 1)
  if (!openid) return undefined
  if (kind !== 'group' && kind !== 'c2c') return undefined
  return { kind, openid }
}

/**
 * 单轮回复允许的最大分段数
 *
 * 平台上限：群聊 5 分钟内同一 msg_id 最多 5 条、单聊 60 分钟内 4 条。
 *
 * 群聊 4：不发确认、也不支持输入状态，留 1 条给附件或错误提示。
 * 单聊 2：会先发一条「正在输入」（msg_type 6，同样带 msg_id + msg_seq，保守假设它
 * 计入配额），再留 1 条给附件或错误提示，因此正文只剩 2 条。
 */
export function maxRepliesFor(kind: QQTargetKind): number {
  return kind === 'group' ? 4 : 2
}

/** 单段文本的字符上限 */
export const QQ_TEXT_CHUNK_SIZE = 2000

/**
 * 截断到单条消息以内
 *
 * 主动消息（定时任务通知）只发一条 —— 通知本身是摘要，完整内容回 Proma 里看，
 * 多发几条只会更快撞上主动消息的频次限制。
 */
export function truncateForSingleMessage(text: string): string {
  if (text.length <= QQ_TEXT_CHUNK_SIZE) return text
  const suffix = '\n\n（内容过长已截断，完整结果见 Proma）'
  return text.slice(0, QQ_TEXT_CHUNK_SIZE - suffix.length) + suffix
}

/**
 * 把回复切成不超过配额的段
 *
 * 超出部分不静默丢弃：末段追加提示，让用户知道内容被截断了。
 */
export function chunkReply(text: string, kind: QQTargetKind): string[] {
  const limit = maxRepliesFor(kind)
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += QQ_TEXT_CHUNK_SIZE) {
    chunks.push(text.slice(i, i + QQ_TEXT_CHUNK_SIZE))
    if (chunks.length === limit) break
  }
  if (chunks.length === 0) return []

  const consumed = chunks.length * QQ_TEXT_CHUNK_SIZE
  if (text.length > consumed) {
    const omitted = text.length - consumed
    chunks[chunks.length - 1] += `\n\n（因 QQ 单条消息回复条数限制，剩余 ${omitted} 字未发送）`
  }
  return chunks
}

/**
 * msg_seq 分配器
 *
 * 同一 msg_id 的多次回复必须递增 msg_seq，重复组合会被平台拒绝。msg_id 的有效期
 * 最长 60 分钟，因此按时间淘汰，并设条数上限防止长期运行后无界增长。
 */
export class MsgSeqAllocator {
  private readonly seqs = new Map<string, { seq: number; touchedAt: number }>()

  constructor(
    private readonly ttlMs = 60 * 60 * 1000,
    private readonly maxEntries = 500,
  ) {}

  /** 取下一个 msg_seq（首次为 1） */
  next(msgId: string, now = Date.now()): number {
    this.evict(now)
    const existing = this.seqs.get(msgId)
    const seq = (existing?.seq ?? 0) + 1
    this.seqs.set(msgId, { seq, touchedAt: now })
    return seq
  }

  private evict(now: number): void {
    for (const [key, value] of this.seqs) {
      if (now - value.touchedAt > this.ttlMs) this.seqs.delete(key)
    }
    // 仍然超量时按插入顺序丢最旧的（Map 保序）
    while (this.seqs.size > this.maxEntries) {
      const oldest = this.seqs.keys().next()
      if (oldest.done) break
      this.seqs.delete(oldest.value)
    }
  }
}
