/**
 * QQ 开放平台 REST 客户端（API v2）
 *
 * 只覆盖群聊 + 单聊所需的四件事：取 WS 网关地址、发消息、上传富媒体、验证凭证。
 *
 * 关键协议点：
 * - 被动回复必须带 `msg_id`（回消息）或 `event_id`（回事件），并带 `msg_seq`；
 *   同一 msg_id 的多次回复靠 msg_seq 递增，重复的 msg_id + msg_seq 会被拒。
 *   三者都不带就是**主动消息**（定时任务通知走这条），另有频次与日限。
 * - 富媒体分两步：先 POST 到 `/files` 拿 `file_info`，再发 `msg_type: 7` +
 *   `media: { file_info }`。上传用 base64，不是 multipart。
 */
import type { QQTargetKind } from './qq-target'
import { QQ_FILE_TYPE, QQ_MSG_TYPE } from '@proma/shared'

const PROD_BASE_URL = 'https://api.sgroup.qq.com'
const SANDBOX_BASE_URL = 'https://sandbox.api.sgroup.qq.com'
const REQUEST_TIMEOUT_MS = 15_000
/** 上传富媒体走 base64，体积会膨胀约 1/3，超时给足 */
const UPLOAD_TIMEOUT_MS = 60_000

/** 发送消息的返回 */
export interface QQSendMessageResult {
  id?: string
  timestamp?: string
}

/** 富媒体上传的返回；file_info 直接塞进消息的 media 字段 */
export interface QQUploadResult {
  file_info: string
  url?: string
  file_id?: string
}

export class QQApiClient {
  constructor(
    private readonly options: {
      sandbox: boolean
      /** 每次调用现取，避免用到过期 token */
      getAuthorization: () => Promise<string>
    },
  ) {}

  private get baseUrl(): string {
    return this.options.sandbox ? SANDBOX_BASE_URL : PROD_BASE_URL
  }

  /** 取 WebSocket 接入地址 */
  async getGatewayUrl(): Promise<string> {
    const data = await this.request<{ url?: string }>('GET', '/gateway')
    if (!data.url) throw new Error('网关接口未返回 url')
    return data.url
  }

  /**
   * 发送 markdown 消息
   *
   * 用 msg_type 2 + markdown.content 走自定义 markdown —— 按官方 2026/04/23 的能力
   * 更新，单聊与群聊的自定义 markdown 已对所有机器人开放，无需申请模板。
   * Agent 的回复本身就是 markdown，发纯文本会让用户看到满屏 ** 和 -。
   *
   * 注意：官方列出的支持语法里**没有代码块与表格**，也未说明长度上限、转义规则、
   * 以及不支持语法的降级方式。这里按产品决定不做预处理，原样发送；若实际渲染不佳，
   * 把 msg_type 改回 TEXT、content 换成 text 即可退回纯文本。
   *
   * @param msgId 收到的消息 id。**省略即主动消息** —— 官方按字段区分消息类型：
   *   带 msg_id 是被动回复、带 event_id 是回事件、都不带就是主动消息。定时任务的
   *   完成通知走这条路（跑完时早已不在被动回复窗口内）。主动消息受频次与日限约束
   *   （个人认证：单聊 1000 条/人/天、群聊 1000 条/群/天，20 条/分钟/关系链），
   *   且用户可以在 QQ 里关掉「允许主动发送」，关了则一律失败。
   * @param msgSeq 同一 msgId 的第几次回复，从 1 开始递增；主动消息不需要
   */
  async sendMarkdown(
    kind: QQTargetKind,
    openid: string,
    text: string,
    msgId?: string,
    msgSeq?: number,
  ): Promise<QQSendMessageResult> {
    return this.request<QQSendMessageResult>('POST', this.messagePath(kind, openid), {
      // markdown 消息仍需带 content 字段（留空），与官方 SDK 的负载结构一致
      content: '',
      msg_type: QQ_MSG_TYPE.MARKDOWN,
      markdown: { content: text },
      ...(msgId ? { msg_id: msgId, msg_seq: msgSeq } : {}),
    })
  }

  /**
   * 上传富媒体并发送
   *
   * `srv_send_msg: false` 表示只上传、不由服务端直接发出，这样我们才能自己带上
   * msg_id / msg_seq 走被动回复。
   */
  async sendMedia(
    kind: QQTargetKind,
    openid: string,
    data: Buffer,
    isImage: boolean,
    msgId: string,
    msgSeq: number,
  ): Promise<QQSendMessageResult> {
    const uploaded = await this.request<QQUploadResult>(
      'POST',
      `${this.targetPath(kind, openid)}/files`,
      {
        file_type: isImage ? QQ_FILE_TYPE.IMAGE : QQ_FILE_TYPE.FILE,
        file_data: data.toString('base64'),
        srv_send_msg: false,
      },
      UPLOAD_TIMEOUT_MS,
    )
    if (!uploaded.file_info) throw new Error('富媒体上传未返回 file_info')

    return this.request<QQSendMessageResult>('POST', this.messagePath(kind, openid), {
      // 富媒体消息的 content 必须存在，留空字符串
      content: '',
      msg_type: QQ_MSG_TYPE.MEDIA,
      media: { file_info: uploaded.file_info },
      msg_id: msgId,
      msg_seq: msgSeq,
    })
  }

  /**
   * 发送「正在输入」状态（仅单聊）
   *
   * 走普通消息端点，但 msg_type 为 6 且带 input_notify —— 官方文档的消息类型页没有
   * 列出这个能力，是从官方 OpenClaw QQ 插件（@tencent-connect/openclaw-qqbot）的
   * sendInputNotify 里确认的。效果是对话里出现「...」气泡，随后被真正的回复取代。
   *
   * 群聊不支持（官方插件里 sendTyping 对非 c2c 直接抛错），因此这里只接受单聊。
   *
   * @param inputSecond 气泡展示时长（秒）
   */
  async sendInputNotify(
    openid: string,
    msgId: string,
    msgSeq: number,
    inputSecond = 30,
  ): Promise<void> {
    await this.request('POST', this.messagePath('c2c', openid), {
      msg_type: QQ_MSG_TYPE.INPUT_NOTIFY,
      input_notify: { input_type: 1, input_second: inputSecond },
      msg_id: msgId,
      msg_seq: msgSeq,
    })
  }

  /** 验证凭证：能取到网关地址即说明 AppID/AppSecret 与网络都正常 */
  async verify(): Promise<void> {
    await this.getGatewayUrl()
  }

  private targetPath(kind: QQTargetKind, openid: string): string {
    return kind === 'group'
      ? `/v2/groups/${encodeURIComponent(openid)}`
      : `/v2/users/${encodeURIComponent(openid)}`
  }

  private messagePath(kind: QQTargetKind, openid: string): string {
    return `${this.targetPath(kind, openid)}/messages`
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const authorization = await this.options.getAuthorization()
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const resp = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: authorization,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
      })
      const text = await resp.text()
      if (!resp.ok) {
        throw new Error(`QQ 接口 ${method} ${path} 失败: HTTP ${resp.status} ${text.slice(0, 300)}`)
      }
      if (!text) return {} as T

      const data = JSON.parse(text) as T & { code?: number; message?: string }
      // 平台会在 HTTP 200 里用 code/message 表达业务错误
      if (typeof data.code === 'number' && data.code !== 0) {
        throw new Error(`QQ 接口 ${method} ${path} 返回错误: ${data.message ?? ''}（code ${data.code}）`)
      }
      return data
    } finally {
      clearTimeout(timer)
    }
  }
}
