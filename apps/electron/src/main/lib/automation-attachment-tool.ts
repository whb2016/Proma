/**
 * 定时任务的「发送附件」工具
 *
 * 为什么需要它：定时任务的 Agent 跑在无人值守的子会话里，本身没有任何把文件交到
 * 用户手上的途径 —— 完成通知只带文本摘要，应用内会话也不渲染 Agent 产出的图片。
 * 实测过一次事故：提示词让 Agent「把截图发给用户」，它读了图片文件（图只是进了
 * 自己的上下文）就宣布「已发给你如上图」，没有任何工具报错能拦住这种编造。
 *
 * 做法与 IM Bridge 的 send_attachment 工具刻意保持同款（见 qq-bridge.ts /
 * wechat-bridge.ts 的 buildPiSendAttachmentTool）：模型显式调用才发，chatId 由闭包
 * 绑定（模型无法指定发给谁），路径必须落在 Agent 自身的授权目录内。差别只是收件人
 * 来自任务配置的远程推送目标，而不是当前正在对话的聊天。
 *
 * 渠道能力判断与文案在 automation-notification-format.ts（纯逻辑，可单测）。
 */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { Automation, AutomationNotificationTarget } from '@proma/shared'
import {
  AUTOMATION_ATTACHMENT_MAX_SIZE,
  AUTOMATION_CHANNEL_LABELS,
  formatAutomationAttachmentTarget,
  resolveAutomationAttachmentTarget,
} from './automation-notification-format'
import { isImageAttachment } from './bridge-outbound-attachment'
import { resolveAgentOutboundAttachment } from './agent-outbound-attachment'
import { wechatBridge } from './wechat-bridge'
import { qqBridgeManager } from './qq-bridge-manager'

export const AUTOMATION_SEND_ATTACHMENT_TOOL = 'mcp__automation__send_attachment'

/**
 * 本轮运行要注入的自定义工具
 *
 * 没有可交付的渠道时返回空数组 —— 此时调度器会在提示词里明确告诉 Agent 它没有外发
 * 通道，不要声称自己发了东西（见 automation-scheduler.ts）。
 */
export function buildAutomationCustomTools(options: {
  automation: Automation
  sessionId: string
}): ToolDefinition[] {
  const target = resolveAutomationAttachmentTarget(options.automation)
  if (!target) return []
  return [buildSendAttachmentTool({
    target,
    sessionId: options.sessionId,
    workspaceId: options.automation.workspaceId ?? '',
  })]
}

function buildSendAttachmentTool(ctx: {
  target: AutomationNotificationTarget
  sessionId: string
  workspaceId: string
}): ToolDefinition {
  const { target } = ctx
  const maxSize = AUTOMATION_ATTACHMENT_MAX_SIZE[target.type]!
  const targetLabel = formatAutomationAttachmentTarget(target)
  const platform = AUTOMATION_CHANNEL_LABELS[target.type] ?? target.type

  return {
    name: AUTOMATION_SEND_ATTACHMENT_TOOL,
    label: `发送附件到${platform}`,
    description: `把一个图片或文件发给本定时任务的通知对象（${targetLabel}）。`
      + '**这是本次运行唯一能把文件交到用户手上的途径** —— 读取文件只是让你自己看到内容，'
      + '不等于用户收到了；没调用本工具就不要说已经发送。'
      + '可发送范围与你的文件读取范围一致：会话工作台、已授权的附加目录、项目文件根 —— '
      + '直接传绝对路径即可，不需要先复制到当前工作目录。'
      + '图片（png/jpg/jpeg/gif/webp/bmp）以图片形式发送，其余按文件发送。'
      + `单个文件上限 ${Math.floor(maxSize / 1024 / 1024)}MB。`
      + '任务结束后系统会自动补一条文字完成通知，不必为了配说明再发一次。',
    promptSnippet: `Automation: use ${AUTOMATION_SEND_ATTACHMENT_TOOL} to actually deliver a file or image to the user (${targetLabel}); reading a file does not deliver it.`,
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

      const resolved = resolveAgentOutboundAttachment({
        sessionId: ctx.sessionId,
        workspaceId: ctx.workspaceId,
        path: rawPath,
        maxSize,
      })
      if (!resolved.ok) return fail(resolved.reason)

      const fileName = basename(resolved.absolutePath)
      const asImage = isImageAttachment(fileName)

      try {
        const data = readFileSync(resolved.absolutePath)
        await deliver(target, data, fileName, asImage)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[定时任务] 交付附件到${platform}失败: chat=${target.chatId}`, error)
        return fail(message)
      }

      return {
        content: [{
          type: 'text',
          text: `已${asImage ? '以图片形式' : '以文件形式'}发送「${fileName}」（${resolved.size} 字节）到${targetLabel}。`,
        }],
        details: { fileName, size: resolved.size, kind: asImage ? 'image' : 'file', channel: target.type },
      } as AgentToolResult<unknown>
    },
  } as ToolDefinition
}

async function deliver(
  target: AutomationNotificationTarget,
  data: Buffer,
  fileName: string,
  asImage: boolean,
): Promise<void> {
  switch (target.type) {
    case 'wechat':
      await wechatBridge.sendAttachmentToChat(target.chatId, data, fileName, asImage)
      return
    case 'qq':
      await qqBridgeManager.sendAttachmentToChat(target.botId, target.chatId, data, asImage)
      return
    default:
      // resolveAutomationAttachmentTarget 已挡掉不支持的渠道，走到这里说明两处不同步
      throw new Error(`渠道不支持发送附件: ${target.type}`)
  }
}
