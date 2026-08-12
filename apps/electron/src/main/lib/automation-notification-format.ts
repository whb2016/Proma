/**
 * 定时任务通知的纯逻辑：文案格式化与渠道能力判断。
 *
 * 与 automation-notification-service.ts / automation-attachment-tool.ts 分开是为了
 * 能脱离 electron 直接单测。
 */

import type {
  Automation,
  AutomationNotificationChannel,
  AutomationNotificationTarget,
  AutomationRun,
  SDKAssistantMessage,
  SDKMessage,
} from '@proma/shared'

interface AutomationNotificationCardPayload {
  automation: Automation
  run: AutomationRun
  summary: string
}

export function shouldNotifyAutomationTarget(
  target: AutomationNotificationTarget,
  status: AutomationRun['status'],
): boolean {
  if (!target.enabled) return false
  if (status === 'skipped') return false
  if (target.trigger === 'always') return true
  return target.trigger === status
}

export function extractAssistantText(messages: SDKMessage[]): string {
  const chunks: string[] = []

  for (const msg of messages) {
    if (msg.type !== 'assistant') continue
    const assistant = msg as SDKAssistantMessage
    for (const block of assistant.message.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        chunks.push(block.text)
      }
    }
  }

  return chunks.join('\n\n').trim()
}

function formatDuration(ms?: number): string {
  if (!ms || ms < 0) return '未知'
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`
  return `${Math.round(ms / 60_000)} 分钟`
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}\n\n... [内容过长，请在 Proma 中查看完整会话]`
}

export function buildAutomationFeishuCard(payload: AutomationNotificationCardPayload): Record<string, unknown> {
  const { automation, run } = payload
  const success = run.status === 'success'
  const title = success ? '定时任务已完成' : '定时任务失败'
  const template = success ? 'green' : 'red'
  const statusLine = success ? '完成' : '失败'
  const fallback = success ? 'Agent 已完成（无文本输出）' : '没有错误详情'

  const lines = [
    `**任务**: ${automation.name}`,
    `**状态**: ${statusLine}`,
    `**耗时**: ${formatDuration(run.durationMs)}`,
    run.sessionId ? `**会话 ID**: ${run.sessionId}` : '',
    '',
    truncate(payload.summary.trim() || fallback, 12000),
  ].filter(Boolean)

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template,
    },
    elements: [
      {
        tag: 'markdown',
        content: lines.join('\n'),
      },
    ],
  }
}

/** 通知正文的摘要上限。IM 通知是摘要，完整内容回 Proma 里看 */
const TEXT_NOTIFICATION_SUMMARY_LIMIT = 1000

/**
 * 纯文本/markdown 形式的完成通知（微信、QQ）
 *
 * 不带会话 ID —— 手机上拿到一串 uuid 没有用，看完整内容还是要回桌面端。
 */
export function buildAutomationTextNotification(payload: AutomationNotificationCardPayload): string {
  const { automation, run } = payload
  const success = run.status === 'success'
  const fallback = success ? 'Agent 已完成（无文本输出）' : '没有错误详情'

  return [
    success ? `✅ 定时任务已完成：${automation.name}` : `❌ 定时任务失败：${automation.name}`,
    `耗时 ${formatDuration(run.durationMs)}`,
    '',
    truncate(payload.summary.trim() || fallback, TEXT_NOTIFICATION_SUMMARY_LIMIT),
  ].join('\n')
}

/** 本机系统通知的标题与正文 */
export function buildAutomationLocalNotification(payload: AutomationNotificationCardPayload): {
  title: string
  body: string
} {
  const { automation, run } = payload
  const success = run.status === 'success'
  const summary = payload.summary.trim()
  // 系统通知只有两三行，取首个非空行；成功但无输出时至少说清耗时
  const firstLine = summary.split('\n').map((line) => line.trim()).find(Boolean)

  return {
    title: success ? '定时任务已完成' : '定时任务失败',
    body: `${automation.name}\n${truncate(firstLine || `耗时 ${formatDuration(run.durationMs)}`, 140)}`,
  }
}

// ===== 推送目标标签 =====

/** 平台展示名 */
export const AUTOMATION_CHANNEL_LABELS: Record<AutomationNotificationChannel, string> = {
  feishu: '飞书',
  wechat: '微信',
  qq: 'QQ',
}

/** 平台侧的 id 都是不可读的长串，展示时截短 */
function shortId(id: string): string {
  return id.length <= 10 ? id : `${id.slice(0, 8)}…`
}

/** 下拉分组名：平台名 + Bot 名（微信是单实例，没有 Bot 名） */
export function formatPushTargetGroupLabel(
  channel: AutomationNotificationChannel,
  botName?: string,
): string {
  const platform = AUTOMATION_CHANNEL_LABELS[channel]
  return botName ? `${platform} ${botName}` : platform
}

/** 飞书聊天名：群用群名，单聊只能显示 id */
export function formatFeishuChatLabel(binding: {
  chatId: string
  chatType?: 'p2p' | 'group'
  groupName?: string
}): string {
  if (binding.chatType === 'group') return binding.groupName || `群 (${shortId(binding.chatId)})`
  return `单聊 (${shortId(binding.chatId)})`
}

/** 微信聊天名：iLink 只给了用户 id，没有昵称 */
export function formatWeChatChatLabel(chatId: string): string {
  return `用户 (${shortId(chatId)})`
}

/** QQ 聊天名：chatId 形如 group:openid / c2c:openid */
export function formatQQChatLabel(chatId: string): string {
  const sep = chatId.indexOf(':')
  const kind = sep > 0 ? chatId.slice(0, sep) : ''
  const openid = sep > 0 ? chatId.slice(sep + 1) : chatId
  const kindLabel = kind === 'group' ? '群' : kind === 'c2c' ? '单聊' : '会话'
  return `${kindLabel} (${shortId(openid)})`
}

// ===== 附件交付能力 =====

/**
 * 各渠道能否交付附件，以及单文件上限（字节）
 *
 * 上限与该平台 Bridge 自己的 send_attachment 工具保持一致。**飞书不在表里**：代码里
 * 没有飞书出站图片/文件的能力（feishu-bridge.ts 只有 sendTextMessage / sendCard，
 * image_key / file_key 全是入站下载路径），它在普通 IM 会话里同样发不了附件。要支持
 * 得先接 im.v1.image.create 上传。
 */
export const AUTOMATION_ATTACHMENT_MAX_SIZE: Partial<Record<AutomationNotificationChannel, number>> = {
  wechat: 20 * 1024 * 1024,
  qq: 10 * 1024 * 1024,
}

/**
 * 本轮运行可用于交付附件的推送目标
 *
 * 取第一个 enabled 的目标：`trigger` 只决定完成通知发不发，与 Agent 显式交付文件无关。
 */
export function resolveAutomationAttachmentTarget(
  automation: Pick<Automation, 'notificationTargets'>,
): AutomationNotificationTarget | undefined {
  const target = (automation.notificationTargets ?? []).find((item) => item.enabled)
  if (!target) return undefined
  return AUTOMATION_ATTACHMENT_MAX_SIZE[target.type] ? target : undefined
}

/** 目标聊天的展示名，用于工具描述与提示词。没有 label 快照时退回平台名 */
export function formatAutomationAttachmentTarget(target: AutomationNotificationTarget): string {
  return target.label || AUTOMATION_CHANNEL_LABELS[target.type] || target.type
}
