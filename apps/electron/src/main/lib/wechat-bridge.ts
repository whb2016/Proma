/**
 * 微信 Bridge 服务
 *
 * 基于微信 iLink Bot API（官方协议）实现：
 * - QR 码扫码登录
 * - HTTP 长轮询接收消息
 * - 发送消息/输入状态
 *
 * 消息路由到 Proma Agent，回复通过 iLink API 发送。
 */

import { BrowserWindow } from 'electron'
import type {
  WeChatBridgeState,
  WeChatCredentials,
  WeChatIncomingMessage,
  WeChatMediaInfo,
  WeChatMessageItem,
} from '@proma/shared'
import { WECHAT_IPC_CHANNELS, WECHAT_ITEM_TYPE, WECHAT_MEDIA_TYPE, WECHAT_MESSAGE_TYPE, WECHAT_MESSAGE_STATE, WECHAT_TYPING_STATUS } from '@proma/shared'
import { getDecryptedCredentials, saveWeChatCredentials, clearWeChatCredentials, getWeChatConfig, updateWeChatDefaultWorkspace } from './wechat-config'
import { getWeChatBindingsPath, getWeChatContextTokensPath, getWeChatSyncPath } from './config-paths'
import { BridgeCommandHandler, type BridgeAttachment, type BridgeChatBinding } from './bridge-command-handler'
import { createJsonBridgeChatBindingStore } from './bridge-binding-store'
import { inferImageMediaType, saveImageToSession, saveFileToSession, inferExtension, MAX_IMAGE_SIZE } from './bridge-attachment-utils'
import { isImageAttachment, resolveOutboundAttachmentPath } from './bridge-outbound-attachment'
import {
  decryptAesEcbWithKey,
  encodeAesKeyBase64,
  encodeAesKeyHex,
  encryptAesEcb,
  generateAesKey,
  parseAesKey,
} from './wechat-media-crypto'
import { getAgentWorkspace } from './agent-workspace-manager'
import { collectAttachedDirectories } from './agent-orchestrator'
import { getAgentSessionMeta } from './agent-session-manager'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { basename } from 'node:path'
import * as crypto from 'node:crypto'
import QRCode from 'qrcode'
import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'

import { redactSensitiveLogText, redactSensitiveLogValue } from './bridge-log-redaction'

// ===== iLink API 常量 =====

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
const QR_CODE_URL = `${DEFAULT_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`
const QR_STATUS_URL = `${DEFAULT_BASE_URL}/ilink/bot/get_qrcode_status?qrcode=`
const LONG_POLL_TIMEOUT_MS = 40_000
const SEND_TIMEOUT_MS = 15_000
const MAX_CONSECUTIVE_FAILURES = 5
const INITIAL_BACKOFF_MS = 3_000

/**
 * iLink 协议版本。官方文档与 SDK 均要求所有业务请求统一携带 base_info.channel_version，
 * 此前仅 getupdates 带了 1.0.0、其余请求传空对象。
 */
const CHANNEL_VERSION = '2.0.0'
const MAX_BACKOFF_MS = 60_000
const SESSION_EXPIRED_CODE = -14
const DOWNLOAD_MEDIA_TIMEOUT_MS = 30_000
const MAX_MEDIA_DOWNLOAD_SIZE = 20 * 1024 * 1024
const MAX_FILE_SIZE = 20 * 1024 * 1024
/** 出站媒体上限。与入站保持一致，避免"能收不能发"的不对称。 */
const MAX_UPLOAD_SIZE = 20 * 1024 * 1024
const UPLOAD_MEDIA_TIMEOUT_MS = 60_000
const UPLOAD_MAX_RETRIES = 3
/** CDN 基址。下载与上传共用。 */
const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
const HANDLE_MESSAGE_TIMEOUT_MS = 90_000
const PENDING_IMAGES_CLEANUP_INTERVAL = 7 * 60 * 1000

/**
 * typing_ticket 缓存时长。文档称有效期约 24 小时，取一半留余量；
 * 重新登录（bot_token 变化）时整表清空。
 */
const TYPING_TICKET_TTL_MS = 12 * 60 * 60 * 1000
/**
 * 输入状态刷新间隔
 *
 * 平台没有说明输入状态多久自动消失，官方 SDK（@wechatbot/wechatbot）也只发一次
 * 不做保活。但 Agent 一轮常要跑几十秒到几分钟，气泡若中途消失就失去了意义，
 * 所以这里定期重发 status=1 兜底。若实测发现状态本就长期有效，可以去掉。
 */
const TYPING_REFRESH_INTERVAL_MS = 15_000
/** 输入状态最长维持时间。Agent 异常挂起时不要把气泡永久留在对话里。 */
const TYPING_MAX_DURATION_MS = 10 * 60 * 1000

const ALLOWED_CDN_HOSTS = [
  '.weixin.qq.com',
  '.wechat.com',
  '.qpic.cn',
  '.qlogo.cn',
]

function isAllowedCdnUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    return ALLOWED_CDN_HOSTS.some(suffix => parsed.hostname.endsWith(suffix))
  } catch {
    return false
  }
}

async function fetchMediaWithSizeGuard(url: string, ac: AbortController, label: string): Promise<Buffer> {
  const resp = await fetch(url, { signal: ac.signal })
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`${label} 失败: HTTP ${resp.status} ${body.slice(0, 200)}`)
  }
  const cl = resp.headers.get('content-length')
  if (cl && parseInt(cl, 10) > MAX_MEDIA_DOWNLOAD_SIZE) {
    ac.abort()
    throw new Error(`${label} 中止: Content-Length ${cl} 超过 ${MAX_MEDIA_DOWNLOAD_SIZE} 限制`)
  }
  const buf = Buffer.from(await resp.arrayBuffer())
  if (buf.length > MAX_MEDIA_DOWNLOAD_SIZE) {
    throw new Error(`${label} 中止: 实际大小 ${buf.length} 超过 ${MAX_MEDIA_DOWNLOAD_SIZE} 限制`)
  }
  return buf
}

// ===== iLink API 响应类型 =====

interface QRCodeResponse {
  qrcode: string
  qrcode_img_content: string
}

interface QRStatusResponse {
  status: string
  bot_token: string
  ilink_bot_id: string
  baseurl: string
  ilink_user_id: string
}

interface GetUpdatesResponse {
  ret: number
  errcode?: number
  errmsg?: string
  msgs: WeChatIncomingMessage[]
  get_updates_buf: string
}

interface SendMessageResponse {
  /** 实测成功时**不返回**该字段，只有出错才带；判成功要用 `ret == null || ret === 0` */
  ret?: number
  errmsg?: string
}

interface GetConfigResponse {
  ret: number
  errmsg?: string
  typing_ticket?: string
}

interface GetUploadUrlResponse {
  ret: number
  errmsg?: string
  /** 完整上传地址；存在时优先使用 */
  upload_full_url?: string
  /** 上传参数；无 upload_full_url 时用它拼 CDN 地址 */
  upload_param?: string
}

/** 上传完成后可直接塞进消息 item 的媒体引用 */
interface UploadedMedia {
  media: WeChatMediaInfo
  /** 密文字节数（file_item.len 用原文大小，这里仅日志与校验用） */
  encryptedSize: number
}

// ===== 工具函数 =====

/**
 * 生成 X-WECHAT-UIN 头的值：随机 4 字节 → uint32 → 十进制字符串 → base64
 *
 * 协议要求**每次请求重新生成**，因此调用点在 post() 内部而不是构造函数。
 * 字节序（LE/BE）无关紧要：输入本就是随机字节，两种解读都得到均匀随机的 uint32。
 */
function generateWechatUIN(): string {
  const buf = crypto.randomBytes(4)
  const n = buf.readUInt32LE()
  return Buffer.from(String(n)).toString('base64')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** CDN 上传的客户端错误（4xx）：确定性失败，不重试 */
class UploadClientError extends Error {}

// ===== iLink HTTP 客户端 =====

class ILinkClient {
  private baseURL: string
  private botToken: string
  private botId: string

  constructor(creds: WeChatCredentials) {
    this.baseURL = creds.baseUrl || DEFAULT_BASE_URL
    this.botToken = creds.botToken
    this.botId = creds.ilinkBotId
  }

  get botID(): string {
    return this.botId
  }

  /** 所有业务请求统一携带的 base_info */
  private baseInfo(): { channel_version: string } {
    return { channel_version: CHANNEL_VERSION }
  }

  /** 长轮询获取消息 */
  async getUpdates(buf: string, signal?: AbortSignal): Promise<GetUpdatesResponse> {
    return this.post<GetUpdatesResponse>('/ilink/bot/getupdates', {
      get_updates_buf: buf,
      base_info: this.baseInfo(),
    }, LONG_POLL_TIMEOUT_MS + 5000, signal)
  }

  /** 发送消息 */
  async sendMessage(toUserId: string, items: WeChatMessageItem[], contextToken: string): Promise<SendMessageResponse> {
    return this.post<SendMessageResponse>('/ilink/bot/sendmessage', {
      msg: {
        from_user_id: this.botId,
        to_user_id: toUserId,
        client_id: `proma_${Date.now()}`,
        message_type: WECHAT_MESSAGE_TYPE.BOT,
        message_state: WECHAT_MESSAGE_STATE.FINISH,
        item_list: items,
        context_token: contextToken,
      },
      base_info: this.baseInfo(),
    }, SEND_TIMEOUT_MS)
  }

  /** 发送文本消息（便捷方法） */
  async sendText(toUserId: string, text: string, contextToken: string): Promise<SendMessageResponse> {
    return this.sendMessage(toUserId, [{
      type: WECHAT_ITEM_TYPE.TEXT,
      text_item: { text },
    }], contextToken)
  }

  /** 取 CDN 上传参数 */
  private async getUploadUrl(params: {
    filekey: string
    media_type: number
    to_user_id: string
    rawsize: number
    rawfilemd5: string
    filesize: number
    no_need_thumb: boolean
    aeskey: string
  }): Promise<GetUploadUrlResponse> {
    return this.post<GetUploadUrlResponse>('/ilink/bot/getuploadurl', {
      ...params,
      base_info: this.baseInfo(),
    }, SEND_TIMEOUT_MS)
  }

  /**
   * 上传媒体到微信 CDN
   *
   * 三步：本地 AES-128-ECB 加密 → getuploadurl 换上传地址 → POST 密文到 CDN，
   * 从响应头 x-encrypted-param 取回 encrypt_query_param。
   *
   * 服务端错误（5xx / 网络）重试，客户端错误（4xx）立即失败 —— 4xx 通常是参数
   * 或鉴权问题，重试只会浪费时间。
   */
  async uploadMedia(options: { data: Buffer; toUserId: string; mediaType: number }): Promise<UploadedMedia> {
    const { data, toUserId, mediaType } = options
    if (data.length === 0) throw new Error('上传内容为空')
    if (data.length > MAX_UPLOAD_SIZE) {
      throw new Error(`上传内容 ${data.length} 字节超过 ${MAX_UPLOAD_SIZE} 限制`)
    }

    const aesKey = generateAesKey()
    const ciphertext = encryptAesEcb(data, aesKey)
    const filekey = crypto.randomBytes(16).toString('hex')
    const rawMd5 = crypto.createHash('md5').update(data).digest('hex')

    const params = await this.getUploadUrl({
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize: data.length,
      rawfilemd5: rawMd5,
      filesize: ciphertext.length,
      no_need_thumb: true,
      aeskey: encodeAesKeyHex(aesKey),
    })

    const uploadFullUrl = params.upload_full_url?.trim()
    if (!uploadFullUrl && !params.upload_param) {
      throw new Error('getuploadurl 未返回上传地址（需要 upload_full_url 或 upload_param）')
    }
    const uploadUrl = uploadFullUrl
      || `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(params.upload_param!)}&filekey=${encodeURIComponent(filekey)}`
    if (!isAllowedCdnUrl(uploadUrl)) throw new Error(`上传 URL 域名不在白名单: ${uploadUrl}`)

    let encryptQueryParam: string | undefined
    let lastError: unknown
    for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), UPLOAD_MEDIA_TIMEOUT_MS)
      try {
        const resp = await fetch(uploadUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array(ciphertext),
          signal: ac.signal,
        })
        const errMsg = resp.headers.get('x-error-message') ?? `HTTP ${resp.status}`
        // 4xx 是确定性失败，直接抛出不重试
        if (resp.status >= 400 && resp.status < 500) {
          throw new UploadClientError(`CDN 上传客户端错误 ${resp.status}: ${errMsg}`)
        }
        if (!resp.ok) throw new Error(`CDN 上传服务端错误: ${errMsg}`)

        encryptQueryParam = resp.headers.get('x-encrypted-param') ?? undefined
        if (!encryptQueryParam) throw new Error('CDN 上传响应缺少 x-encrypted-param 头')
        break
      } catch (err) {
        if (err instanceof UploadClientError) throw err
        lastError = err
        if (attempt < UPLOAD_MAX_RETRIES) {
          console.warn(`[微信 Bridge] CDN 上传第 ${attempt} 次失败，重试:`, redactSensitiveLogValue(err))
        }
      } finally {
        clearTimeout(timer)
      }
    }

    if (!encryptQueryParam) {
      throw lastError instanceof Error ? lastError : new Error(`CDN 上传 ${UPLOAD_MAX_RETRIES} 次均失败`)
    }

    return {
      media: {
        encrypt_query_param: encryptQueryParam,
        aes_key: encodeAesKeyBase64(aesKey),
        encrypt_type: 1,
      },
      encryptedSize: ciphertext.length,
    }
  }

  /** 上传并发送图片 */
  async sendImage(toUserId: string, data: Buffer, contextToken: string): Promise<SendMessageResponse> {
    const { media } = await this.uploadMedia({ data, toUserId, mediaType: WECHAT_MEDIA_TYPE.IMAGE })
    return this.sendMessage(toUserId, [{
      type: WECHAT_ITEM_TYPE.IMAGE,
      image_item: { media },
    }], contextToken)
  }

  /** 上传并发送文件 */
  async sendFile(toUserId: string, data: Buffer, fileName: string, contextToken: string): Promise<SendMessageResponse> {
    const { media } = await this.uploadMedia({ data, toUserId, mediaType: WECHAT_MEDIA_TYPE.FILE })
    return this.sendMessage(toUserId, [{
      type: WECHAT_ITEM_TYPE.FILE,
      file_item: {
        media,
        file_name: fileName,
        md5: crypto.createHash('md5').update(data).digest('hex'),
        // len 是原文大小，不是密文大小
        len: String(data.length),
      },
    }], contextToken)
  }

  /** 获取配置（typing_ticket） */
  async getConfig(userId: string, contextToken: string): Promise<GetConfigResponse> {
    return this.post<GetConfigResponse>('/ilink/bot/getconfig', {
      ilink_user_id: userId,
      context_token: contextToken,
      base_info: this.baseInfo(),
    }, 10_000)
  }

  /** 发送"正在输入"状态 */
  async sendTyping(userId: string, typingTicket: string, status: number): Promise<void> {
    await this.post('/ilink/bot/sendtyping', {
      ilink_user_id: userId,
      typing_ticket: typingTicket,
      status,
      base_info: this.baseInfo(),
    }, 10_000)
  }

  /**
   * 下载图片
   *
   * 策略：
   * 1. 如果 image_item.url 存在，直接 fetch（部分图片服务端已解密）
   * 2. 否则通过 media.encrypt_query_param 构建 CDN URL，fetch 加密字节后用 AES-128-ECB 解密
   *
   * aes_key 格式不确定，依次尝试 base64→16B / base64→hex→16B / hex→16B。
   */
  async downloadImage(item: WeChatMessageItem): Promise<Buffer> {
    const img = item.image_item
    if (!img) throw new Error('缺少 image_item')

    // 路径 1: 直接使用 url（须校验域名白名单）
    if (img.url) {
      if (!isAllowedCdnUrl(img.url)) throw new Error(`图片 URL 域名不在白名单: ${img.url}`)
      const ac = new AbortController()
      const t = setTimeout(() => ac.abort(), DOWNLOAD_MEDIA_TIMEOUT_MS)
      try {
        return await fetchMediaWithSizeGuard(img.url, ac, '图片直连下载')
      } finally {
        clearTimeout(t)
      }
    }

    if (!img.media) throw new Error('image_item 既无 url 也无 media')
    const encryptQueryParam = img.media.encrypt_query_param
    const fullUrl = img.media.full_url

    // aeskey: image_item.aeskey (hex) 或 media.aes_key (base64)
    let aesKeyBase64: string | undefined
    if (img.aeskey) {
      aesKeyBase64 = Buffer.from(img.aeskey, 'hex').toString('base64')
    } else if (img.media.aes_key) {
      aesKeyBase64 = img.media.aes_key
    }

    if (!encryptQueryParam && !fullUrl) throw new Error('缺少 encrypt_query_param 和 full_url')

    const cdnBaseUrl = CDN_BASE_URL
    const url = fullUrl ?? `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam!)}`
    if (!isAllowedCdnUrl(url)) throw new Error(`图片 CDN URL 域名不在白名单: ${url}`)

    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), DOWNLOAD_MEDIA_TIMEOUT_MS)
    let encrypted: Buffer
    try {
      encrypted = await fetchMediaWithSizeGuard(url, ac, 'CDN 图片下载')
    } finally {
      clearTimeout(t)
    }

    if (!aesKeyBase64) return encrypted

    const key = parseAesKey(aesKeyBase64)
    return decryptAesEcbWithKey(encrypted, key)
  }

  /**
   * 下载文件
   *
   * 通过 file_item.media 的 CDN 参数下载并 AES-128-ECB 解密。
   */
  async downloadFile(item: WeChatMessageItem): Promise<Buffer> {
    const file = item.file_item
    if (!file) throw new Error('缺少 file_item')
    if (!file.media) throw new Error('file_item 缺少 media')

    const encryptQueryParam = file.media.encrypt_query_param
    const fullUrl = file.media.full_url
    const aesKeyBase64 = file.media.aes_key

    if (!encryptQueryParam && !fullUrl) throw new Error('缺少 encrypt_query_param 和 full_url')

    const cdnBaseUrl = CDN_BASE_URL
    const url = fullUrl ?? `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam!)}`
    if (!isAllowedCdnUrl(url)) throw new Error(`文件 CDN URL 域名不在白名单: ${url}`)

    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), DOWNLOAD_MEDIA_TIMEOUT_MS)
    let encrypted: Buffer
    try {
      encrypted = await fetchMediaWithSizeGuard(url, ac, 'CDN 文件下载')
    } finally {
      clearTimeout(t)
    }

    if (!aesKeyBase64) return encrypted

    const key = parseAesKey(aesKeyBase64)
    return decryptAesEcbWithKey(encrypted, key)
  }

  private async post<T>(path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    // 合并外部 signal，并确保清理监听器
    let onAbort: (() => void) | null = null
    if (signal && !signal.aborted) {
      onAbort = () => controller.abort()
      signal.addEventListener('abort', onAbort)
    } else if (signal?.aborted) {
      clearTimeout(timeout)
      throw new Error('Request aborted')
    }

    try {
      const resp = await fetch(this.baseURL + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'AuthorizationType': 'ilink_bot_token',
          'Authorization': `Bearer ${this.botToken}`,
          'X-WECHAT-UIN': generateWechatUIN(),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!resp.ok) {
        const text = await resp.text()
        throw new Error(`HTTP ${resp.status}: ${text}`)
      }

      return await resp.json() as T
    } finally {
      clearTimeout(timeout)
      if (onAbort && signal) {
        signal.removeEventListener('abort', onAbort)
      }
    }
  }
}

// ===== 单例 Bridge =====

interface WeChatImageAttachment {
  id: string
  data: Buffer
  mediaType: string
}

interface WeChatFileAttachment {
  id: string
  data: Buffer
  fileName: string
}

class WeChatBridge {
  private client: ILinkClient | null = null
  private state: WeChatBridgeState = { status: 'disconnected' }
  private pollAbortController: AbortController | null = null
  private loginAbortController: AbortController | null = null
  private getUpdatesBuf = ''
  private polling = false
  private pendingImages = new Map<string, { images: WeChatImageAttachment[]; createdAt: number }>()
  private pendingFiles = new Map<string, { files: WeChatFileAttachment[]; createdAt: number }>()
  private static readonly PENDING_IMAGES_TTL = 10 * 60 * 1000 // 10 minutes
  private static readonly PENDING_IMAGES_MAX = 15
  private static readonly PENDING_FILES_MAX = 15
  /** context_token 缓存条数上限（聊天绑定通常只有个位数） */
  private static readonly MAX_CONTEXT_TOKENS = 200
  private pendingImagesCleanupTimer: ReturnType<typeof setInterval> | null = null
  /** chatId → typing_ticket 缓存（取 ticket 要额外一次 getconfig） */
  private typingTickets = new Map<string, { ticket: string; fetchedAt: number }>()
  /** chatId → 正在维持的输入状态（存在即表示该会话处于「正在输入」） */
  private typingSessions = new Map<string, { timer: ReturnType<typeof setInterval>; ticket: string }>()
  /**
   * chatId → 最近一次收到消息时的 context_token
   *
   * 发消息必须带 context_token，而它只随入站消息下发。定时任务的完成通知是主动
   * 推送、手上没有新消息，只能复用最近这一个。持久化是为了应用重启后仍能推送
   * （否则用户得先手动发一条消息才能收到通知）。
   */
  private lastContextTokens = new Map<string, string>()

  /** 通用命令处理器（命令路由 + Agent 消息路由 + EventBus 监听） */
  private commandHandler = new BridgeCommandHandler({
    platformName: '微信',
    adapter: {
      sendText: async (chatId: string, text: string, meta?: unknown) => {
        if (!this.client) return
        const ctx = meta as { contextToken?: string } | undefined
        const contextToken = ctx?.contextToken ?? ''
        // 回复即将出现，先摘下输入状态（同步停掉保活，否则刷新会把气泡重新点亮）
        const typingTicket = this.takeTypingSession(chatId)
        // 微信单条消息有长度限制，超长分段
        const MAX_LEN = 4000
        const chunks = text.length <= MAX_LEN
          ? [text]
          : text.match(new RegExp(`.{1,${MAX_LEN}}`, 'gs')) ?? [text]
        for (const chunk of chunks) {
          await this.client.sendText(chatId, chunk, contextToken)
        }
        if (typingTicket) await this.hideTyping(chatId, typingTicket)
      },
    },
    getDefaultWorkspaceId: () => getWeChatConfig().defaultWorkspaceId,
    bindingStore: createJsonBridgeChatBindingStore(getWeChatBindingsPath(), '微信 Bridge'),
    onWorkspaceSwitched: (workspaceId) => updateWeChatDefaultWorkspace(workspaceId),
    buildPiCustomTools: (ctx) => [this.buildPiSendAttachmentTool(ctx)],
    // 不发「⏳ Agent 处理中...」：改用微信原生的「正在输入」状态提示，
    // 少一条噪音消息，也不会在会话里留下一条过时的中间态文本。
    sendProcessingNotice: false,
  })

  /**
   * 「发送附件给微信用户」工具
   *
   * 出站媒体必须由模型显式调用才发送：解析回复文本里的路径会误发（模型提到某个
   * 文件不等于想发它），把本轮新建的文件全发出去则会带上临时产物。
   *
   * 安全边界：chatId 与 contextToken 由闭包绑定，模型无法指定发给谁；路径必须落在
   * 本会话工作区内（见 resolveOutboundAttachmentPath），避免把本机任意文件发出去。
   */
  private buildPiSendAttachmentTool(ctx: {
    chatId: string
    contextData: unknown
    workspaceId: string
    sessionId: string
  }): ToolDefinition {
    return {
      name: 'mcp__wechat__send_attachment',
      label: '发送附件到微信',
      description: '把一个图片或文件发送给正在对话的微信用户。'
        + '可发送范围与你的文件读取范围一致：会话工作台、已授权的附加目录、项目文件根 —— '
        + '直接传绝对路径即可，不需要先复制到当前工作目录。'
        + '图片（png/jpg/jpeg/gif/webp/bmp）以图片形式发送，其余按文件发送。'
        + '仅在用户要求获取文件、或你生成了需要交付的产物时使用；单个文件上限 20MB。',
      promptSnippet: 'WeChat: use mcp__wechat__send_attachment to deliver a file or image to the user; any path you may read is allowed, no copying needed.',
      parameters: Type.Object({
        path: Type.String({ description: '要发送的文件路径。推荐绝对路径；相对路径按会话工作台等授权目录依次解析。' }),
        caption: Type.Optional(Type.String({ description: '可选的说明文字，会作为一条独立文本消息在附件前发送。' })),
      }),
      execute: async (_toolCallId, args): Promise<AgentToolResult<unknown>> => {
        const input = args && typeof args === 'object' ? args as Record<string, unknown> : {}
        const rawPath = typeof input.path === 'string' ? input.path : ''
        const caption = typeof input.caption === 'string' ? input.caption.trim() : ''

        const fail = (reason: string): AgentToolResult<unknown> => ({
          content: [{ type: 'text', text: `发送失败：${reason}` }],
          isError: true,
          details: { reason },
        } as AgentToolResult<unknown>)

        if (!this.client) return fail('微信未连接')

        const workspace = getAgentWorkspace(ctx.workspaceId)
        if (!workspace) return fail('工作区不存在')

        // 与 Agent 自身的授权目录一致：会话工作台、会话/工作区附加目录、项目文件根。
        // 用 getProjectFilesPath 单根会漏掉 Agent 的 cwd（会话工作台，附件就在那里），
        // 逼模型先复制一份 —— 而上游提示词明确要求"不要先复制到当前工作目录"。
        const roots = collectAttachedDirectories({
          sessionMeta: getAgentSessionMeta(ctx.sessionId),
          workspaceSlug: workspace.slug,
        })

        const resolved = resolveOutboundAttachmentPath(roots, rawPath, MAX_UPLOAD_SIZE)
        if (!resolved.ok) return fail(resolved.reason)

        const contextToken = (ctx.contextData as { contextToken?: string } | undefined)?.contextToken ?? ''
        const fileName = basename(resolved.absolutePath)
        const asImage = isImageAttachment(fileName)

        try {
          const data = readFileSync(resolved.absolutePath)
          if (caption) {
            await this.client.sendText(ctx.chatId, caption, contextToken)
          }
          if (asImage) {
            await this.client.sendImage(ctx.chatId, data, contextToken)
          } else {
            await this.client.sendFile(ctx.chatId, data, fileName, contextToken)
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          console.error('[微信 Bridge] 发送附件失败:', redactSensitiveLogValue(error))
          return fail(message)
        }

        return {
          content: [{
            type: 'text',
            text: `已${asImage ? '以图片形式' : '以文件形式'}发送「${fileName}」（${resolved.size} 字节）。`,
          }],
          details: { fileName, size: resolved.size, kind: asImage ? 'image' : 'file' },
        } as AgentToolResult<unknown>
      },
    } as ToolDefinition
  }

  /** 获取当前状态 */
  getStatus(): WeChatBridgeState {
    return { ...this.state }
  }

  /** 在删除项目时清理指向其会话的聊天绑定。 */
  removeBindingsForDeletedWorkspace(workspaceId: string, sessionIds: Iterable<string>): number {
    return this.commandHandler.removeBindingsForDeletedWorkspace(workspaceId, sessionIds)
  }

  /** 当前有效的聊天绑定（定时任务推送目标列表用） */
  listBindings(): BridgeChatBinding[] {
    return this.commandHandler.listBindings()
  }

  /** 反查会话绑定在哪个聊天上 */
  getChatIdBySessionId(sessionId: string): string | undefined {
    return this.commandHandler.getChatIdBySessionId(sessionId)
  }

  /**
   * 主动发一条消息到指定聊天（定时任务完成通知）
   *
   * iLink 的 sendmessage 必须带 context_token，而 token 只能从收到的消息里拿 ——
   * 所以这里用缓存的最近一次 token。官方没有说明 token 的有效期，因此它有可能已经
   * 失效。
   *
   * 注意：iLink 的失败是 HTTP 200 + `ret != 0`，通用 post() 不检查这个字段，所以
   * 必须在这里自己判 —— 否则推送失败会被当成成功，用户既收不到通知也看不到原因。
   * 但**成功时响应里根本没有 ret**（实测），因此缺字段要算成功，不能按 `!== 0` 判。
   */
  async sendTextToChat(chatId: string, text: string): Promise<void> {
    if (!this.client) throw new Error('微信未连接')
    const contextToken = this.lastContextTokens.get(chatId)
    if (!contextToken) {
      throw new Error('没有可用的会话上下文（请先在微信里给 Bot 发一条消息）')
    }
    const resp = await this.client.sendText(chatId, text, contextToken)
    if (typeof resp.ret === 'number' && resp.ret !== 0) {
      const detail = resp.errmsg ? `: ${resp.errmsg}` : ''
      throw new Error(`微信拒绝了推送（ret=${resp.ret}${detail}），会话上下文可能已过期`)
    }
  }

  /** 开始扫码登录流程 */
  async startLogin(): Promise<void> {
    // 清理现有连接，但不推送 'disconnected' 状态，避免 UI 闪烁导致重复触发
    this.loginAbortController?.abort()
    this.pollAbortController?.abort()
    this.pollAbortController = null
    this.client = null
    this.polling = false

    this.loginAbortController = new AbortController()

    try {
      // 1. 获取二维码（立即设置 waiting_scan，不经过 disconnected）
      this.updateStatus({ status: 'waiting_scan' })
      const qrResp = await this.fetchQRCode()
      // qrcode_img_content 是扫码 URL，用 qrcode 库在 main 进程中生成二维码 data URL
      const scanUrl = qrResp.qrcode_img_content
      const qrDataUrl = await QRCode.toDataURL(scanUrl, { width: 280, margin: 2 })
      this.updateStatus({
        status: 'waiting_scan',
        qrCodeData: qrDataUrl,
      })
      console.log('[微信 Bridge] QR 码已获取，等待扫码...')

      // 2. 轮询扫码状态
      const creds = await this.pollQRStatus(qrResp.qrcode)

      // 3. 保存凭证
      saveWeChatCredentials(creds)
      console.log('[微信 Bridge] 登录成功，凭证已保存')

      // 4. 启动长轮询
      await this.startPolling(creds)
    } catch (error) {
      if (this.loginAbortController?.signal.aborted) return
      const msg = redactSensitiveLogText(error instanceof Error ? error.message : String(error))
      this.updateStatus({ status: 'error', errorMessage: msg, qrCodeData: undefined })
      console.error('[微信 Bridge] 登录失败:', msg)
      throw error
    }
  }

  /** 用已有凭证启动长轮询 */
  async start(): Promise<void> {
    const creds = getDecryptedCredentials()
    if (!creds) {
      throw new Error('没有已保存的微信凭证，请先扫码登录')
    }
    await this.startPolling(creds)
  }

  /** 停止所有连接 */
  stop(): void {
    this.loginAbortController?.abort()
    this.loginAbortController = null
    this.pollAbortController?.abort()
    this.pollAbortController = null
    // 必须在 client 置空前熄灯，否则气泡会一直留在用户的会话里
    this.clearTypingSessions()
    this.client = null
    this.polling = false
    this.commandHandler.unsubscribe()
    if (this.pendingImagesCleanupTimer) {
      clearInterval(this.pendingImagesCleanupTimer)
      this.pendingImagesCleanupTimer = null
    }
    this.pendingImages.clear()
    this.pendingFiles.clear()
    this.updateStatus({ status: 'disconnected', qrCodeData: undefined })
    console.log('[微信 Bridge] 已停止')
  }

  /** 登出（停止连接 + 清除凭证） */
  logout(): void {
    this.stop()
    clearWeChatCredentials()
    this.getUpdatesBuf = ''
    this.saveSyncBuf()
    // 换号后旧 token 必然无效，留着只会让推送报错
    this.lastContextTokens.clear()
    this.saveContextTokens()
    console.log('[微信 Bridge] 已登出')
  }

  // ===== 内部方法 =====

  private async fetchQRCode(): Promise<QRCodeResponse> {
    const resp = await fetch(QR_CODE_URL)
    if (!resp.ok) throw new Error(`获取二维码失败: HTTP ${resp.status}`)
    return await resp.json() as QRCodeResponse
  }

  private async pollQRStatus(qrcode: string): Promise<WeChatCredentials> {
    const signal = this.loginAbortController!.signal

    while (!signal.aborted) {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 40_000)
        const onAbort = (): void => controller.abort()
        signal.addEventListener('abort', onAbort)

        let resp: Response
        try {
          resp = await fetch(QR_STATUS_URL + qrcode, { signal: controller.signal })
        } finally {
          clearTimeout(timeout)
          signal.removeEventListener('abort', onAbort)
        }

        if (!resp.ok) {
          if (signal.aborted) break
          continue
        }

        const data = await resp.json() as QRStatusResponse

        switch (data.status) {
          case 'confirmed': {
            if (!data.bot_token || !data.ilink_bot_id) {
              throw new Error('扫码成功但未获取到有效凭证')
            }
            this.updateStatus({ status: 'connecting', qrCodeData: undefined })
            return {
              botToken: data.bot_token,
              ilinkBotId: data.ilink_bot_id,
              baseUrl: data.baseurl,
              ilinkUserId: data.ilink_user_id,
            }
          }
          case 'scaned':
            this.updateStatus({ status: 'scanned' })
            break
          case 'expired':
            throw new Error('二维码已过期，请重新获取')
          case 'wait':
          default:
            break
        }
      } catch (error) {
        if (signal.aborted) break
        // 超时是正常的，继续轮询
        if (error instanceof Error && error.name === 'AbortError') continue
        throw error
      }
    }

    throw new Error('登录已取消')
  }

  private async startPolling(creds: WeChatCredentials): Promise<void> {
    // 防止并发启动
    if (this.polling) {
      this.stop()
    }

    this.polling = true // 先设标志，防止并发
    this.client = new ILinkClient(creds)
    this.pollAbortController = new AbortController()
    this.loadSyncBuf()
    this.loadContextTokens()

    // 订阅 Agent EventBus 接收 Agent 回复
    this.commandHandler.subscribe()

    // 定期清理过期的图片缓冲
    this.pendingImagesCleanupTimer = setInterval(() => this.cleanExpiredPendingImages(), PENDING_IMAGES_CLEANUP_INTERVAL)

    this.updateStatus({ status: 'connected', connectedAt: Date.now(), qrCodeData: undefined })
    console.log('[微信 Bridge] 长轮询已启动')

    // 后台运行长轮询循环
    this.pollLoop().catch((error) => {
      if (!this.pollAbortController?.signal.aborted) {
        const msg = redactSensitiveLogText(error instanceof Error ? error.message : String(error))
        this.updateStatus({ status: 'error', errorMessage: msg })
        console.error('[微信 Bridge] 长轮询异常退出:', msg)
      }
    })
  }

  private async pollLoop(): Promise<void> {
    const signal = this.pollAbortController!.signal
    let failures = 0

    while (!signal.aborted) {
      try {
        const resp = await this.client!.getUpdates(this.getUpdatesBuf, signal)
        failures = 0

        // Session 过期
        if (resp.errcode === SESSION_EXPIRED_CODE) {
          if (this.getUpdatesBuf) {
            console.log('[微信 Bridge] session 过期，重置同步游标')
            this.getUpdatesBuf = ''
            this.saveSyncBuf()
          } else {
            // Bot token 本身过期，需要重新登录
            this.updateStatus({ status: 'error', errorMessage: '微信会话已过期，请重新扫码登录' })
            return
          }
          await sleep(5000)
          continue
        }

        // 其他服务端错误
        if (resp.ret !== 0 && resp.errcode) {
          console.warn('[微信 Bridge] 服务端错误:', resp.ret, resp.errcode, redactSensitiveLogText(resp.errmsg ?? ''))
          continue
        }

        // 更新同步游标
        if (resp.get_updates_buf) {
          this.getUpdatesBuf = resp.get_updates_buf
          this.saveSyncBuf()
        }

        // 处理消息（串行避免同一 chatId 并发创建 session，单条超时保护）
        for (const msg of resp.msgs) {
          let timeoutId: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([
              this.handleMessage(msg),
              new Promise<never>((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error('handleMessage 超时')), HANDLE_MESSAGE_TIMEOUT_MS)
              }),
            ])
          } catch (error) {
            console.error('[微信 Bridge] 处理消息失败:', redactSensitiveLogValue(error))
          } finally {
            if (timeoutId) clearTimeout(timeoutId)
          }
        }
      } catch (error) {
        if (signal.aborted) return

        failures++
        const backoff = Math.min(INITIAL_BACKOFF_MS * Math.pow(2, failures - 1), MAX_BACKOFF_MS)
        console.warn(`[微信 Bridge] 轮询失败 (${failures}/${MAX_CONSECUTIVE_FAILURES}, backoff=${backoff}ms):`, redactSensitiveLogValue(error))

        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          console.warn('[微信 Bridge] 连续失败过多，可能需要重新登录')
        }

        await sleep(backoff)
      }
    }
  }

  private cleanExpiredPendingImages(): void {
    const now = Date.now()
    for (const [chatId, entry] of this.pendingImages) {
      if (now - entry.createdAt > WeChatBridge.PENDING_IMAGES_TTL) {
        console.log(`[微信 Bridge] 清理过期图片缓冲: ${chatId.slice(0, 8)}... (${entry.images.length} 张)`)
        this.pendingImages.delete(chatId)
      }
    }
    for (const [chatId, entry] of this.pendingFiles) {
      if (now - entry.createdAt > WeChatBridge.PENDING_IMAGES_TTL) {
        console.log(`[微信 Bridge] 清理过期文件缓冲: ${chatId.slice(0, 8)}... (${entry.files.length} 个)`)
        this.pendingFiles.delete(chatId)
      }
    }
  }

  /** 处理收到的消息，委托给通用命令处理器 */
  private async handleMessage(msg: WeChatIncomingMessage): Promise<void> {
    // 只处理已完成的用户消息
    if (msg.message_type !== WECHAT_MESSAGE_TYPE.USER) return
    if (msg.message_state !== WECHAT_MESSAGE_STATE.FINISH) return
    if (!this.client) return

    const text = msg.item_list
      .filter((item) => item.type === WECHAT_ITEM_TYPE.TEXT && item.text_item)
      .map((item) => item.text_item!.text)
      .join('')

    const imageItems = msg.item_list.filter(
      (item) => item.type === WECHAT_ITEM_TYPE.IMAGE && item.image_item,
    )

    const fileItems = msg.item_list.filter(
      (item) => item.type === WECHAT_ITEM_TYPE.FILE && item.file_item,
    )

    const chatId = msg.from_user_id
    const contextToken = msg.context_token

    // 纯粹的空消息
    if (!text.trim() && imageItems.length === 0 && fileItems.length === 0) return

    // 记下 token：定时任务的完成通知是主动推送，届时只能靠这个最近值
    this.rememberContextToken(chatId, contextToken)

    console.log('[微信 Bridge] 收到消息:', redactSensitiveLogValue({
      from: chatId,
      messageId: msg.message_id,
      text: text.length > 100 ? text.slice(0, 100) + '...' : text,
      imageCount: imageItems.length,
      fileCount: fileItems.length,
    }))

    // 下载图片
    const imageDownloads: WeChatImageAttachment[] = []
    const msgId = msg.message_id ?? `msg-${Date.now()}`
    for (let idx = 0; idx < imageItems.length; idx++) {
      try {
        const buf = await this.client.downloadImage(imageItems[idx]!)
        const mediaType = inferImageMediaType(buf)
        if (buf.length > MAX_IMAGE_SIZE) {
          console.warn(`[微信 Bridge] 图片超过大小限制: ${(buf.length / 1024 / 1024).toFixed(1)}MB`)
          await this.client.sendText(chatId, `⚠️ 一张图片超过 ${MAX_IMAGE_SIZE / 1024 / 1024}MB 限制，已跳过`, contextToken)
          continue
        }
        imageDownloads.push({ id: `${msgId}-img-${idx}`, data: buf, mediaType })
      } catch (error) {
        console.error('[微信 Bridge] 图片下载失败:', redactSensitiveLogValue(error))
        await this.client.sendText(chatId, '⚠️ 一张图片下载失败，已跳过', contextToken)
      }
    }

    // 下载文件
    const fileDownloads: WeChatFileAttachment[] = []
    for (let idx = 0; idx < fileItems.length; idx++) {
      const fileItem = fileItems[idx]!
      const fileName = fileItem.file_item!.file_name || `file_${msgId}_${idx}`
      // 预检文件大小（len 字段为字符串形式的字节数）
      const declaredSize = fileItem.file_item!.len ? parseInt(fileItem.file_item!.len, 10) : 0
      if (declaredSize > MAX_FILE_SIZE) {
        console.warn(`[微信 Bridge] 文件超过大小限制: ${(declaredSize / 1024 / 1024).toFixed(1)}MB, 文件名: ${fileName}`)
        await this.client.sendText(chatId, `⚠️ 文件「${fileName}」超过 20MB 限制，已跳过`, contextToken)
        continue
      }
      try {
        const buf = await this.client.downloadFile(fileItem)
        if (buf.length > MAX_FILE_SIZE) {
          console.warn(`[微信 Bridge] 文件实际大小超限: ${(buf.length / 1024 / 1024).toFixed(1)}MB, 文件名: ${fileName}`)
          await this.client.sendText(chatId, `⚠️ 文件「${fileName}」超过 20MB 限制，已跳过`, contextToken)
          continue
        }
        fileDownloads.push({ id: `${msgId}-file-${idx}`, data: buf, fileName })
      } catch (error) {
        console.error(`[微信 Bridge] 文件下载失败 (${fileName}):`, redactSensitiveLogValue(error))
        await this.client.sendText(chatId, `⚠️ 文件「${fileName}」下载失败，已跳过`, contextToken)
      }
    }

    const hasMedia = imageDownloads.length > 0 || fileDownloads.length > 0

    // 清理过期缓冲
    this.cleanExpiredPendingImages()

    // 纯媒体消息（无文字）→ 缓冲，等待文字触发
    if (!text.trim() && hasMedia) {
      // 缓冲图片
      if (imageDownloads.length > 0) {
        const entry = this.pendingImages.get(chatId)
        const existing = entry ? entry.images : []
        const merged = [...existing, ...imageDownloads].slice(-WeChatBridge.PENDING_IMAGES_MAX)
        this.pendingImages.set(chatId, { images: merged, createdAt: entry?.createdAt ?? Date.now() })
      }
      // 缓冲文件
      if (fileDownloads.length > 0) {
        const entry = this.pendingFiles.get(chatId)
        const existing = entry ? entry.files : []
        const merged = [...existing, ...fileDownloads].slice(-WeChatBridge.PENDING_FILES_MAX)
        this.pendingFiles.set(chatId, { files: merged, createdAt: entry?.createdAt ?? Date.now() })
      }
      const imgCount = (this.pendingImages.get(chatId)?.images.length ?? 0)
      const fileCount = (this.pendingFiles.get(chatId)?.files.length ?? 0)
      const parts: string[] = []
      if (imgCount > 0) parts.push(`${imgCount} 张图片`)
      if (fileCount > 0) parts.push(`${fileCount} 个文件`)
      await this.client.sendText(
        chatId,
        `📎 已收到 ${parts.join('和 ')}，请继续发送文字消息以触发处理。`,
        contextToken,
      )
      return
    }

    // 文字消息（可能携带或触发缓冲的媒体）
    if (!text.trim()) return

    // 合并缓冲图片
    const pendingImgEntry = this.pendingImages.get(chatId)
    const pendingImgs = pendingImgEntry ? pendingImgEntry.images : []
    const allImages = [...pendingImgs, ...imageDownloads]
    this.pendingImages.delete(chatId)

    // 合并缓冲文件
    const pendingFileEntry = this.pendingFiles.get(chatId)
    const pendingFls = pendingFileEntry ? pendingFileEntry.files : []
    const allFiles = [...pendingFls, ...fileDownloads]
    this.pendingFiles.delete(chatId)

    // 无媒体 → 原有纯文本路径
    if (allImages.length === 0 && allFiles.length === 0) {
      await this.startTyping(chatId, text, contextToken)
      await this.commandHandler.handleIncomingMessage(chatId, text, { contextToken })
      return
    }

    // 命令消息携带媒体（极少见）：把媒体放回缓冲，仅处理命令
    if (text.trimStart().startsWith('/')) {
      if (allImages.length > 0) {
        this.pendingImages.set(chatId, { images: allImages, createdAt: Date.now() })
      }
      if (allFiles.length > 0) {
        this.pendingFiles.set(chatId, { files: allFiles, createdAt: Date.now() })
      }
      await this.commandHandler.handleIncomingMessage(chatId, text, { contextToken })
      return
    }

    // 有媒体：先检查 session 是否正在运行
    if (this.commandHandler.isSessionActive(chatId)) {
      if (allImages.length > 0) {
        this.pendingImages.set(chatId, { images: allImages, createdAt: Date.now() })
      }
      if (allFiles.length > 0) {
        this.pendingFiles.set(chatId, { files: allFiles, createdAt: Date.now() })
      }
      await this.client.sendText(chatId, '❌ 上一条消息仍在处理中，附件已暂存，请稍候再试', contextToken)
      return
    }

    // 确保 binding 存在，保存媒体到会话目录
    const binding = this.commandHandler.ensureBinding(chatId)
    if (!binding) {
      await this.client.sendText(chatId, '请先在 Proma 设置中选择 Agent 渠道。', contextToken)
      return
    }
    const workspace = binding.workspaceId ? getAgentWorkspace(binding.workspaceId) : undefined
    if (!workspace) {
      await this.client.sendText(chatId, '⚠️ 当前未设置项目，无法保存附件', contextToken)
      return
    }

    const attachments: BridgeAttachment[] = []

    // 保存图片
    for (const img of allImages) {
      const hint = `wechat-${img.id}`
      const absolutePath = saveImageToSession(
        workspace.slug,
        binding.sessionId,
        hint,
        img.mediaType,
        img.data,
      )
      const label = `${hint}.${inferExtension(img.mediaType)}`
      attachments.push({ absolutePath, label, kind: 'image' as const })
    }

    // 保存文件
    for (const file of allFiles) {
      const absolutePath = saveFileToSession(
        workspace.slug,
        binding.sessionId,
        file.fileName,
        file.data,
      )
      attachments.push({ absolutePath, label: file.fileName, kind: 'file' as const })
    }

    await this.startTyping(chatId, text, contextToken)
    await this.commandHandler.handleIncomingMessage(chatId, text, { contextToken }, attachments)
  }

  // ===== 「正在输入」状态 =====

  /**
   * 点亮「正在输入」并保活
   *
   * 只用于会触发 Agent 的普通消息：命令的回复是即时的，亮一下反而闪。
   * 全程失败静默 —— 这是体验优化，不该影响消息处理。
   */
  private async startTyping(chatId: string, text: string, contextToken: string): Promise<void> {
    if (!this.client) return
    if (text.trimStart().startsWith('/')) return

    // 幂等：重复调用不叠加定时器
    const stale = this.takeTypingSession(chatId)
    if (stale) await this.hideTyping(chatId, stale)

    const ticket = await this.getTypingTicket(chatId, contextToken)
    if (!ticket) return
    if (!(await this.sendTypingStatus(chatId, ticket, WECHAT_TYPING_STATUS.START))) return

    const startedAt = Date.now()
    const timer = setInterval(() => {
      if (Date.now() - startedAt > TYPING_MAX_DURATION_MS) {
        const held = this.takeTypingSession(chatId)
        if (held) void this.hideTyping(chatId, held)
        return
      }
      void this.sendTypingStatus(chatId, ticket, WECHAT_TYPING_STATUS.START)
    }, TYPING_REFRESH_INTERVAL_MS)
    this.typingSessions.set(chatId, { timer, ticket })
  }

  /**
   * 摘下输入状态：停掉保活并交出 ticket
   *
   * 返回 undefined 表示该会话本来就不处于输入态（不必多发一次 status=2）。
   * 拆成"摘下"与"隐藏"两步，是为了让调用方能先同步停掉保活、再决定何时通知平台。
   */
  private takeTypingSession(chatId: string): string | undefined {
    const session = this.typingSessions.get(chatId)
    if (!session) return undefined
    clearInterval(session.timer)
    this.typingSessions.delete(chatId)
    return session.ticket
  }

  /** 通知平台隐藏输入状态 */
  private async hideTyping(chatId: string, ticket: string): Promise<void> {
    await this.sendTypingStatus(chatId, ticket, WECHAT_TYPING_STATUS.STOP)
  }

  /** 发送输入状态，返回是否成功（失败仅告警） */
  private async sendTypingStatus(chatId: string, ticket: string, status: number): Promise<boolean> {
    // 同步取用，避免 await 期间 stop() 把 client 置空
    const client = this.client
    if (!client) return false
    try {
      await client.sendTyping(chatId, ticket, status)
      return true
    } catch (error) {
      console.warn('[微信 Bridge] 发送输入状态失败（忽略）:', redactSensitiveLogValue(error))
      return false
    }
  }

  /** 取 typing_ticket（按用户缓存；需要 context_token） */
  private async getTypingTicket(chatId: string, contextToken: string): Promise<string | undefined> {
    const cached = this.typingTickets.get(chatId)
    if (cached && Date.now() - cached.fetchedAt < TYPING_TICKET_TTL_MS) return cached.ticket
    if (!contextToken) return undefined

    const client = this.client
    if (!client) return undefined
    try {
      const resp = await client.getConfig(chatId, contextToken)
      if (!resp.typing_ticket) return undefined
      this.typingTickets.set(chatId, { ticket: resp.typing_ticket, fetchedAt: Date.now() })
      return resp.typing_ticket
    } catch (error) {
      this.typingTickets.delete(chatId)
      console.warn('[微信 Bridge] 获取 typing_ticket 失败（忽略）:', redactSensitiveLogValue(error))
      return undefined
    }
  }

  /** 断开前收尾：熄掉所有输入状态并丢弃 ticket（bot_token 变化后 ticket 失效） */
  private clearTypingSessions(): void {
    for (const chatId of [...this.typingSessions.keys()]) {
      const ticket = this.takeTypingSession(chatId)
      if (ticket) void this.hideTyping(chatId, ticket)
    }
    this.typingTickets.clear()
  }

  // ===== 会话上下文持久化 =====

  /**
   * 记下某个聊天最近一次的 context_token
   *
   * 只在值变化时落盘 —— 每条入站消息都写文件没必要。条数上限防止长期运行后无界
   * 增长；聊天绑定通常只有个位数，200 足够。
   */
  private rememberContextToken(chatId: string, contextToken: string): void {
    if (!contextToken) return
    if (this.lastContextTokens.get(chatId) === contextToken) return
    this.lastContextTokens.set(chatId, contextToken)
    while (this.lastContextTokens.size > WeChatBridge.MAX_CONTEXT_TOKENS) {
      const oldest = this.lastContextTokens.keys().next()
      if (oldest.done) break
      this.lastContextTokens.delete(oldest.value)
    }
    this.saveContextTokens()
  }

  private loadContextTokens(): void {
    const path = getWeChatContextTokensPath()
    if (!existsSync(path)) return
    try {
      const data = JSON.parse(readFileSync(path, 'utf-8')) as unknown
      if (!data || typeof data !== 'object') return
      for (const [chatId, token] of Object.entries(data as Record<string, unknown>)) {
        if (typeof token === 'string' && token) this.lastContextTokens.set(chatId, token)
      }
      if (this.lastContextTokens.size > 0) {
        console.log(`[微信 Bridge] 已加载 ${this.lastContextTokens.size} 个会话上下文`)
      }
    } catch {
      // 坏文件不值得中断启动：下一条入站消息会重新写入
    }
  }

  private saveContextTokens(): void {
    try {
      writeFileSync(
        getWeChatContextTokensPath(),
        JSON.stringify(Object.fromEntries(this.lastContextTokens)),
        'utf-8',
      )
    } catch (error) {
      console.warn('[微信 Bridge] 保存会话上下文失败:', redactSensitiveLogValue(error))
    }
  }

  // ===== 同步游标持久化 =====

  private loadSyncBuf(): void {
    const syncPath = getWeChatSyncPath()
    if (!existsSync(syncPath)) return
    try {
      const data = JSON.parse(readFileSync(syncPath, 'utf-8'))
      if (data.get_updates_buf) {
        this.getUpdatesBuf = data.get_updates_buf
        console.log('[微信 Bridge] 已加载同步游标')
      }
    } catch {
      // 忽略
    }
  }

  private saveSyncBuf(): void {
    const syncPath = getWeChatSyncPath()
    try {
      writeFileSync(syncPath, JSON.stringify({ get_updates_buf: this.getUpdatesBuf }), 'utf-8')
    } catch (error) {
      console.warn('[微信 Bridge] 保存同步游标失败:', redactSensitiveLogValue(error))
    }
  }

  // ===== 状态推送 =====

  private updateStatus(partial: Partial<WeChatBridgeState>): void {
    this.state = { ...this.state, ...partial }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(WECHAT_IPC_CHANNELS.STATUS_CHANGED, this.state)
      }
    }
  }
}

export const wechatBridge = new WeChatBridge()
