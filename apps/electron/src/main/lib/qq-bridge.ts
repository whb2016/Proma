/**
 * QQ 机器人 Bridge
 *
 * 一个 Bot 一个实例：WebSocket 收事件（群 @ 与单聊）→ 交给 BridgeCommandHandler
 * 路由到 Agent → 回复经 REST 被动回复发回。
 *
 * 与微信 Bridge 的两处关键差异：
 * 1. 回复要带 msg_id + 递增的 msg_seq，且分段数受平台配额限制（见 qq-target.ts）
 * 2. 出站富媒体是"先上传拿 file_info 再发 msg_type:7"，没有加解密环节
 */
import type { BridgeAttachment, BridgeChatBinding } from './bridge-command-handler'
import { BridgeCommandHandler } from './bridge-command-handler'
import type {
  QQBotBridgeState,
  QQBotConfig,
  QQBridgeState,
  QQIncomingMessage,
  QQMessageAttachment,
} from '@proma/shared'
import { QQ_EVENT, QQ_INTENTS, QQ_IPC_CHANNELS } from '@proma/shared'
import { BrowserWindow } from 'electron'
import { QQApiClient } from './qq-api-client'
import { QQAuth } from './qq-auth'
import { QQGatewayClient } from './qq-gateway-client'
import {
  MsgSeqAllocator,
  chunkReply,
  decodeQQChatId,
  encodeQQChatId,
  truncateForSingleMessage,
  type QQTarget,
} from './qq-target'
import { getDecryptedBotAppSecret, updateQQBotDefaultWorkspace } from './qq-config'
import { getQQBotBindingsPath } from './config-paths'
import { createJsonBridgeChatBindingStore } from './bridge-binding-store'
import { isImageAttachment } from './bridge-outbound-attachment'
import { resolveAgentOutboundAttachment } from './agent-outbound-attachment'
import {
  MAX_IMAGE_SIZE,
  inferImageMediaType,
  saveFileToSession,
  saveImageToSession,
} from './bridge-attachment-utils'
import { getAgentWorkspace } from './agent-workspace-manager'
import { redactSensitiveLogValue } from './bridge-log-redaction'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'

/** 出站附件上限。QQ 未公开明确数值，取与入站图片一致的保守值。 */
const MAX_UPLOAD_SIZE = 10 * 1024 * 1024
const MAX_ATTACHMENT_DOWNLOAD_SIZE = 20 * 1024 * 1024
const ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 30_000

export class QQBridge {
  private botConfig: QQBotConfig
  private api: QQApiClient | null = null
  private gateway: QQGatewayClient | null = null
  private state: QQBridgeState = { status: 'disconnected' }
  private readonly msgSeq = new MsgSeqAllocator()
  /** chatId → 最近一条用户消息的 msg_id，被动回复要用 */
  private readonly lastMsgIds = new Map<string, string>()
  private readonly commandHandler: BridgeCommandHandler

  constructor(botConfig: QQBotConfig) {
    this.botConfig = botConfig
    this.commandHandler = new BridgeCommandHandler({
      platformName: `QQ:${botConfig.name}`,
      adapter: {
        sendText: async (chatId: string, text: string) => {
          await this.sendReply(chatId, text)
        },
      },
      getDefaultWorkspaceId: () => this.botConfig.defaultWorkspaceId,
      bindingStore: createJsonBridgeChatBindingStore(
        getQQBotBindingsPath(botConfig.id),
        `QQ Bridge:${botConfig.name}`,
      ),
      onWorkspaceSwitched: (workspaceId) => updateQQBotDefaultWorkspace(this.botConfig.id, workspaceId),
      buildPiCustomTools: (ctx) => [this.buildPiSendAttachmentTool(ctx)],
      // 单聊改用「正在输入」气泡（见 onEvent），群聊不支持该能力只能静默等待。
      // 另外 QQ 的被动回复条数是硬配额，「⏳ Agent 处理中...」会白占一次。
      sendProcessingNotice: false,
    })
  }

  get id(): string {
    return this.botConfig.id
  }

  getStatus(): QQBridgeState {
    return { ...this.state }
  }

  updateConfig(botConfig: QQBotConfig): void {
    this.botConfig = botConfig
  }

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
   * 不带 msg_id，因此是**主动消息**：不受被动回复窗口限制，但受主动消息频次与日限
   * 约束，且用户可以在 QQ 里关掉「允许主动发送」—— 关了会在这里抛错，由调用方
   * 降级处理。
   */
  async sendTextToChat(chatId: string, text: string): Promise<void> {
    const target = decodeQQChatId(chatId)
    if (!target) throw new Error(`非法的 QQ 会话标识: ${chatId}`)
    if (!this.api || this.state.status !== 'connected') {
      throw new Error(`QQ Bot "${this.botConfig.name}" 未连接`)
    }
    await this.api.sendMarkdown(target.kind, target.openid, truncateForSingleMessage(text))
  }

  /**
   * 主动发一个附件到指定聊天（定时任务交付产物）
   *
   * 同样不带 msg_id，是主动消息 —— 约束与 {@link sendTextToChat} 一致。
   */
  async sendAttachmentToChat(chatId: string, data: Buffer, asImage: boolean): Promise<void> {
    const target = decodeQQChatId(chatId)
    if (!target) throw new Error(`非法的 QQ 会话标识: ${chatId}`)
    if (!this.api || this.state.status !== 'connected') {
      throw new Error(`QQ Bot "${this.botConfig.name}" 未连接`)
    }
    await this.api.sendMedia(target.kind, target.openid, data, asImage)
  }

  private get logPrefix(): string {
    return `[QQ Bridge:${this.botConfig.name}]`
  }

  /** 更新状态并推送到渲染进程 */
  private setState(next: QQBridgeState): void {
    this.state = next
    const botState: QQBotBridgeState = {
      ...next,
      botId: this.botConfig.id,
      botName: this.botConfig.name,
    }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(QQ_IPC_CHANNELS.MULTI_STATUS_CHANGED, botState)
      }
    }
  }

  async start(): Promise<void> {
    if (this.gateway) return
    const appSecret = getDecryptedBotAppSecret(this.botConfig.id)
    if (!this.botConfig.appId || !appSecret) {
      this.setState({ status: 'error', errorMessage: '未配置 AppID 或 AppSecret' })
      return
    }

    const auth = new QQAuth(this.botConfig.appId, appSecret)
    const api = new QQApiClient({
      sandbox: this.botConfig.sandbox,
      getAuthorization: () => auth.getAuthorizationHeader(),
    })
    this.api = api

    this.gateway = new QQGatewayClient({
      getAuthorization: () => auth.getAuthorizationHeader(),
      getGatewayUrl: () => api.getGatewayUrl(),
      // 群 @ 与单聊事件都在这一个 intent 里；它需要在开放平台单独申请权限
      intents: QQ_INTENTS.GROUP_AND_C2C_EVENT,
      logPrefix: this.logPrefix,
      callbacks: {
        onEvent: (eventName, data) => {
          void this.onEvent(eventName, data)
        },
        onStatus: (status, errorMessage) => {
          if (status === 'connected') {
            this.setState({ status: 'connected', connectedAt: Date.now() })
          } else if (status === 'connecting') {
            this.setState({ status: 'connecting' })
          } else {
            // 断线由网关客户端自行重连，这里标记 error 让自愈守护与 UI 可见
            this.setState({ status: errorMessage ? 'error' : 'disconnected', errorMessage })
          }
        },
      },
    })

    this.commandHandler.subscribe()
    await this.gateway.start()
  }

  stop(): void {
    this.gateway?.stop()
    this.gateway = null
    this.api = null
    this.commandHandler.unsubscribe()
    this.lastMsgIds.clear()
    this.setState({ status: 'disconnected' })
  }

  /** 验证凭证：能取到网关地址即通 */
  static async testConnection(appId: string, appSecret: string, sandbox: boolean): Promise<void> {
    const auth = new QQAuth(appId, appSecret)
    const api = new QQApiClient({ sandbox, getAuthorization: () => auth.getAuthorizationHeader() })
    await api.verify()
  }

  // ===== 入站 =====

  private async onEvent(eventName: string, data: unknown): Promise<void> {
    if (eventName !== QQ_EVENT.GROUP_AT_MESSAGE_CREATE && eventName !== QQ_EVENT.C2C_MESSAGE_CREATE) {
      return
    }
    const message = data as QQIncomingMessage | undefined
    if (!message?.id) return

    const target = this.resolveTarget(eventName, message)
    if (!target) {
      console.warn(`${this.logPrefix} 事件 ${eventName} 缺少 openid，已跳过`)
      return
    }
    const chatId = encodeQQChatId(target)
    this.lastMsgIds.set(chatId, message.id)

    // 群里 @ 机器人时 content 会带 @ 前缀，去掉后再交给 Agent
    const text = (message.content ?? '').replace(/<@!?\d+>/g, '').trim()
    const attachments = await this.saveAttachments(chatId, message.attachments)

    // 单聊先亮「正在输入」气泡，取代原先那条「⏳ Agent 处理中」文本消息。
    // 群聊不支持该能力，只能静默等待。
    if (target.kind === 'c2c') {
      await this.sendTypingIndicator(target.openid, message.id)
    }

    try {
      await this.commandHandler.handleIncomingMessage(
        chatId,
        text,
        undefined,
        attachments.length > 0 ? attachments : undefined,
      )
    } catch (error) {
      console.error(`${this.logPrefix} 处理消息失败:`, redactSensitiveLogValue(error))
    }
  }

  private resolveTarget(eventName: string, message: QQIncomingMessage): QQTarget | undefined {
    if (eventName === QQ_EVENT.GROUP_AT_MESSAGE_CREATE) {
      return message.group_openid ? { kind: 'group', openid: message.group_openid } : undefined
    }
    const openid = message.author?.user_openid
    return openid ? { kind: 'c2c', openid } : undefined
  }

  /** 下载入站富媒体并落盘到会话，返回 handler 需要的附件引用 */
  private async saveAttachments(
    chatId: string,
    attachments?: QQMessageAttachment[],
  ): Promise<BridgeAttachment[]> {
    if (!attachments?.length) return []
    // 附件要落到会话的 attachments 目录，因此需要先确保绑定存在
    const binding = this.commandHandler.ensureBinding(chatId)
    if (!binding) return []
    const workspace = getAgentWorkspace(binding.workspaceId)
    if (!workspace) return []

    const saved: BridgeAttachment[] = []
    for (const attachment of attachments) {
      if (!attachment.url) continue
      // 平台返回的 url 常常不带协议前缀
      const url = /^https?:\/\//i.test(attachment.url) ? attachment.url : `https://${attachment.url}`
      try {
        const data = await this.download(url)
        const isImage = (attachment.content_type ?? '').startsWith('image/')
          || (attachment.filename ? isImageAttachment(attachment.filename) : false)

        if (isImage) {
          if (data.length > MAX_IMAGE_SIZE) {
            console.warn(`${this.logPrefix} 图片超过 ${MAX_IMAGE_SIZE} 字节，已跳过`)
            continue
          }
          const mediaType = inferImageMediaType(data)
          const path = saveImageToSession(
            workspace.slug,
            binding.sessionId,
            `qq-${Date.now()}`,
            mediaType,
            data,
          )
          saved.push({ absolutePath: path, label: basename(path), kind: 'image' })
        } else {
          const fileName = attachment.filename || basename(new URL(url).pathname) || 'file'
          const path = saveFileToSession(workspace.slug, binding.sessionId, fileName, data)
          saved.push({ absolutePath: path, label: fileName, kind: 'file' })
        }
      } catch (error) {
        console.error(`${this.logPrefix} 下载附件失败:`, redactSensitiveLogValue(error))
      }
    }
    return saved
  }

  private async download(url: string): Promise<Buffer> {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), ATTACHMENT_DOWNLOAD_TIMEOUT_MS)
    try {
      const resp = await fetch(url, { signal: ac.signal })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const declared = resp.headers.get('content-length')
      if (declared && Number(declared) > MAX_ATTACHMENT_DOWNLOAD_SIZE) {
        ac.abort()
        throw new Error(`声明大小 ${declared} 超过 ${MAX_ATTACHMENT_DOWNLOAD_SIZE} 限制`)
      }
      const buf = Buffer.from(await resp.arrayBuffer())
      if (buf.length > MAX_ATTACHMENT_DOWNLOAD_SIZE) {
        throw new Error(`实际大小 ${buf.length} 超过 ${MAX_ATTACHMENT_DOWNLOAD_SIZE} 限制`)
      }
      return buf
    } finally {
      clearTimeout(timer)
    }
  }

  // ===== 出站 =====

  /**
   * 亮「正在输入」气泡（仅单聊）
   *
   * 失败不应影响正常回复 —— 这只是个体验优化，出错就静默跳过。
   */
  private async sendTypingIndicator(openid: string, msgId: string): Promise<void> {
    if (!this.api) return
    try {
      await this.api.sendInputNotify(openid, msgId, this.msgSeq.next(msgId))
    } catch (error) {
      console.warn(`${this.logPrefix} 发送输入状态失败（忽略）:`, redactSensitiveLogValue(error))
    }
  }

  /** 发送回复：按配额分段，每段递增 msg_seq。内容按 markdown 发送。 */
  private async sendReply(chatId: string, text: string): Promise<void> {
    const target = decodeQQChatId(chatId)
    const msgId = this.lastMsgIds.get(chatId)
    if (!this.api || !target || !msgId) {
      console.warn(`${this.logPrefix} 无法发送回复：缺少连接或 msg_id (${chatId})`)
      return
    }

    for (const chunk of chunkReply(text, target.kind)) {
      await this.api.sendMarkdown(target.kind, target.openid, chunk, msgId, this.msgSeq.next(msgId))
    }
  }

  /**
   * 「发送附件到 QQ」工具
   *
   * 与微信同款设计：由模型显式调用（避免解析回复文本误发），chatId 由闭包绑定
   * （模型无法指定发给谁），路径必须落在 Agent 自身的授权目录内。
   */
  private buildPiSendAttachmentTool(ctx: {
    chatId: string
    contextData: unknown
    workspaceId: string
    sessionId: string
  }): ToolDefinition {
    return {
      name: 'mcp__qq__send_attachment',
      label: '发送附件到 QQ',
      description: '把一个图片或文件发送给正在对话的 QQ 用户或群。'
        + '可发送范围与你的文件读取范围一致：会话工作台、已授权的附加目录、项目文件根 —— '
        + '直接传绝对路径即可，不需要先复制到当前工作目录。'
        + '图片（png/jpg/jpeg/gif/webp/bmp）以图片形式发送，其余按文件发送。'
        + '仅在用户要求获取文件、或你生成了需要交付的产物时使用；单个文件上限 10MB。'
        + '注意 QQ 对单条消息的回复条数有限制，附件会占用一次，不要连续发送多个。',
      promptSnippet: 'QQ: use mcp__qq__send_attachment to deliver a file or image to the user; any path you may read is allowed.',
      parameters: Type.Object({
        path: Type.String({ description: '要发送的文件路径。推荐绝对路径；相对路径按会话工作台等授权目录依次解析。' }),
      }),
      execute: async (_toolCallId, args): Promise<AgentToolResult<unknown>> => {
        const input = args && typeof args === 'object' ? args as Record<string, unknown> : {}
        const rawPath = typeof input.path === 'string' ? input.path : ''

        const fail = (reason: string): AgentToolResult<unknown> => ({
          content: [{ type: 'text', text: `发送失败：${reason}` }],
          isError: true,
          details: { reason },
        } as AgentToolResult<unknown>)

        const target = decodeQQChatId(ctx.chatId)
        const msgId = this.lastMsgIds.get(ctx.chatId)
        if (!this.api || !target) return fail('QQ 未连接')
        if (!msgId) return fail('没有可回复的消息（QQ 只允许被动回复）')

        const resolved = resolveAgentOutboundAttachment({
          sessionId: ctx.sessionId,
          workspaceId: ctx.workspaceId,
          path: rawPath,
          maxSize: MAX_UPLOAD_SIZE,
        })
        if (!resolved.ok) return fail(resolved.reason)

        const fileName = basename(resolved.absolutePath)
        const asImage = isImageAttachment(fileName)
        try {
          const data = readFileSync(resolved.absolutePath)
          await this.api.sendMedia(
            target.kind,
            target.openid,
            data,
            asImage,
            msgId,
            this.msgSeq.next(msgId),
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          console.error(`${this.logPrefix} 发送附件失败:`, redactSensitiveLogValue(error))
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
}
