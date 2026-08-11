/**
 * QQ 机器人集成相关类型定义
 *
 * 走 QQ 开放平台开发者 API v2 + WebSocket 长连接（不走 Webhook：后者要求公网
 * HTTPS 且端口限 80/443/8080/8443，桌面应用不具备）。凭证只需 AppID + AppSecret。
 *
 * 与钉钉不同，这里只定义多 Bot 一种配置格式 —— QQ 是新接入的平台，没有需要
 * 向后兼容的单 Bot 旧格式。
 */

// ===== Bot 配置 =====

/** 单个 QQ Bot 配置 */
export interface QQBotConfig {
  /** Bot 唯一标识（UUID） */
  id: string
  /** Bot 显示名称 */
  name: string
  /** 是否启用 */
  enabled: boolean
  /** QQ 开放平台应用 AppID */
  appId: string
  /** QQ 开放平台应用 AppSecret（safeStorage 加密后的 base64 字符串） */
  appSecret: string
  /**
   * 是否使用沙箱环境。
   * 发布审核通过前只能用沙箱，且沙箱 Bot 仅接收沙箱测试频道/群的消息。
   */
  sandbox: boolean
  /** 该 Bot 的默认工作区 ID */
  defaultWorkspaceId?: string
  /** 该 Bot 的默认渠道 ID */
  defaultChannelId?: string
  /** 该 Bot 的默认模型 ID */
  defaultModelId?: string
}

/** 多 Bot 配置文件（~/.proma/qq.json） */
export interface QQMultiBotConfig {
  version: 1
  bots: QQBotConfig[]
}

/** 单个 Bot 配置保存输入（明文 secret，主进程负责加密） */
export interface QQBotConfigInput {
  /** Bot ID（新建时不传，更新时必传） */
  id?: string
  name: string
  enabled: boolean
  appId: string
  /** 明文 AppSecret（空字符串表示不修改） */
  appSecret: string
  sandbox: boolean
  defaultWorkspaceId?: string
  defaultChannelId?: string
  defaultModelId?: string
}

// ===== Bridge 连接状态 =====

export type QQBridgeStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface QQBridgeState {
  status: QQBridgeStatus
  /** 上次连接成功时间 */
  connectedAt?: number
  /** 错误信息 */
  errorMessage?: string
}

/** 单个 Bot 的 Bridge 状态（包含身份信息） */
export interface QQBotBridgeState extends QQBridgeState {
  botId: string
  botName: string
}

/** 多 Bot Bridge 状态聚合 */
export interface QQMultiBridgeState {
  /** botId → 状态 */
  bots: Record<string, QQBotBridgeState>
}

/** 连接测试结果 */
export interface QQTestResult {
  success: boolean
  message: string
}

// ===== 协议常量 =====

/** WebSocket opcode */
export const QQ_OPCODE = {
  /** 服务端推送事件，带 t（事件名）与 s（序号） */
  DISPATCH: 0,
  /** 心跳，d 为已收到的最新 s */
  HEARTBEAT: 1,
  /** 鉴权 */
  IDENTIFY: 2,
  /** 恢复连接 */
  RESUME: 6,
  /** 服务端要求重连 */
  RECONNECT: 7,
  /** identify/resume 参数无效 */
  INVALID_SESSION: 9,
  /** 建连后的第一条消息，d.heartbeat_interval 为心跳周期（毫秒） */
  HELLO: 10,
  /** 心跳回执 */
  HEARTBEAT_ACK: 11,
} as const

/**
 * 事件订阅 intents（按位或组合）
 *
 * GROUP_AND_C2C_EVENT 不在默认可订阅范围内，**必须在开放平台申请权限**，
 * 否则连接建立后会立刻被断开。
 */
export const QQ_INTENTS = {
  /** 群聊 @ 机器人、单聊消息、机器人被加入/移出群等 */
  GROUP_AND_C2C_EVENT: 1 << 25,
} as const

/** 需要处理的事件名（Dispatch 的 t 字段） */
export const QQ_EVENT = {
  /** 用户在群里 @ 机器人 */
  GROUP_AT_MESSAGE_CREATE: 'GROUP_AT_MESSAGE_CREATE',
  /** 用户单聊发消息给机器人 */
  C2C_MESSAGE_CREATE: 'C2C_MESSAGE_CREATE',
  /** 鉴权成功 */
  READY: 'READY',
  /** 断线重连补发完毕 */
  RESUMED: 'RESUMED',
} as const

/** 发送消息的 msg_type */
export const QQ_MSG_TYPE = {
  TEXT: 0,
  MARKDOWN: 2,
  /**
   * 「正在输入」状态（仅单聊），配合 input_notify 字段。
   *
   * 官方文档的消息类型页未列出，取值来自官方 OpenClaw QQ 插件
   * （@tencent-connect/openclaw-qqbot）的 sendInputNotify 实现。
   */
  INPUT_NOTIFY: 6,
  /** 富媒体，需配合 media.file_info */
  MEDIA: 7,
} as const

/**
 * 富媒体上传的 file_type
 *
 * 注意与 QQ_MSG_TYPE 是两套取值，别混用。
 */
export const QQ_FILE_TYPE = {
  IMAGE: 1,
  VIDEO: 2,
  VOICE: 3,
  FILE: 4,
} as const

// ===== 入站事件负载 =====

/** 入站消息附件（图片/文件等富媒体） */
export interface QQMessageAttachment {
  /** 直链地址，通常不带协议前缀 */
  url?: string
  /** MIME 类型 */
  content_type?: string
  filename?: string
  size?: number
  /** 语音附件自带的免费 ASR 结果 */
  asr_refer_text?: string
}

/** 群聊 @ 机器人 / 单聊消息的事件负载 */
export interface QQIncomingMessage {
  /** 消息 ID，被动回复时原样带回 */
  id: string
  content: string
  timestamp?: string
  attachments?: QQMessageAttachment[]
  /** 群聊场景存在 */
  group_openid?: string
  author: {
    /** 单聊场景的用户标识 */
    user_openid?: string
    /** 群聊场景的成员标识 */
    member_openid?: string
  }
}

// ===== IPC 通道常量 =====

export const QQ_IPC_CHANNELS = {
  /** 获取多 Bot 配置 */
  GET_MULTI_CONFIG: 'qq:get-multi-config',
  /** 保存单个 Bot 配置（新建或更新） */
  SAVE_BOT_CONFIG: 'qq:save-bot-config',
  /** 删除 Bot */
  REMOVE_BOT: 'qq:remove-bot',
  /** 获取单个 Bot 的解密 AppSecret */
  GET_BOT_DECRYPTED_SECRET: 'qq:get-bot-decrypted-secret',
  /** 测试连接（取 access token 验证凭证） */
  TEST_CONNECTION: 'qq:test-connection',
  /** 启动单个 Bot Bridge */
  START_BOT: 'qq:start-bot',
  /** 停止单个 Bot Bridge */
  STOP_BOT: 'qq:stop-bot',
  /** 获取多 Bot Bridge 状态 */
  GET_MULTI_STATUS: 'qq:get-multi-status',
  /** 多 Bot 状态变化推送（主进程 → 渲染进程） */
  MULTI_STATUS_CHANGED: 'qq:multi-status-changed',
} as const
