/**
 * 定时任务的远程推送目标注册表
 *
 * 把「哪些聊天可以推」和「某个会话是从哪个聊天进来的」这两件事集中在一处，供设置
 * 界面的下拉列表与 Agent 的默认值推导共用。
 *
 * 只汇总**运行中 Bridge** 的绑定：Bot 没连上时推也推不出去，列出来只会误导。
 */

import type {
  AutomationNotificationChannel,
  AutomationNotificationTarget,
  AutomationPushTargetOption,
} from '@proma/shared'
import { WECHAT_SINGLETON_BOT_ID } from '@proma/shared'
import { feishuBridgeManager } from './feishu-bridge-manager'
import { getFeishuBotById } from './feishu-config'
import { wechatBridge } from './wechat-bridge'
import { qqBridgeManager } from './qq-bridge-manager'
import {
  formatFeishuChatLabel,
  formatPushTargetGroupLabel,
  formatQQChatLabel,
  formatWeChatChatLabel,
} from './automation-notification-format'

function option(
  channel: AutomationNotificationChannel,
  botId: string,
  chatId: string,
  chatLabel: string,
  botName?: string,
): AutomationPushTargetOption {
  const groupLabel = formatPushTargetGroupLabel(channel, botName)
  return { channel, botId, chatId, groupLabel, label: `${groupLabel} · ${chatLabel}` }
}

/** 可选的远程推送目标，按平台顺序（飞书 → 微信 → QQ）排列 */
export function listAutomationPushTargets(): AutomationPushTargetOption[] {
  const options: AutomationPushTargetOption[] = []

  // 飞书：归档的绑定不再列出，与设置里的行为一致
  for (const binding of feishuBridgeManager.listAllBindings()) {
    if (binding.archived) continue
    options.push(option(
      'feishu',
      binding.botId,
      binding.chatId,
      formatFeishuChatLabel(binding),
      getFeishuBotById(binding.botId)?.name,
    ))
  }

  if (wechatBridge.getStatus().status === 'connected') {
    for (const binding of wechatBridge.listBindings()) {
      options.push(option('wechat', WECHAT_SINGLETON_BOT_ID, binding.chatId, formatWeChatChatLabel(binding.chatId)))
    }
  }

  for (const bot of qqBridgeManager.listAllBindings()) {
    for (const binding of bot.bindings) {
      options.push(option('qq', bot.botId, binding.chatId, formatQQChatLabel(binding.chatId), bot.botName))
    }
  }

  return options
}

/**
 * 反查会话是从哪个聊天进来的
 *
 * Agent 在远程聊天里创建定时任务时，用这个把完成通知默认推回原处。桌面端会话查不到，
 * 返回 undefined（此时只发本机通知）。
 */
export function resolveSessionPushTarget(sessionId: string): AutomationNotificationTarget | undefined {
  const toTarget = (opt: AutomationPushTargetOption): AutomationNotificationTarget => ({
    type: opt.channel,
    enabled: true,
    trigger: 'always',
    botId: opt.botId,
    chatId: opt.chatId,
    label: opt.label,
  })

  const feishu = feishuBridgeManager.listAllBindings().find((b) => b.sessionId === sessionId && !b.archived)
  if (feishu) {
    return toTarget(option(
      'feishu',
      feishu.botId,
      feishu.chatId,
      formatFeishuChatLabel(feishu),
      getFeishuBotById(feishu.botId)?.name,
    ))
  }

  const wechatChatId = wechatBridge.getChatIdBySessionId(sessionId)
  if (wechatChatId) {
    return toTarget(option(
      'wechat',
      WECHAT_SINGLETON_BOT_ID,
      wechatChatId,
      formatWeChatChatLabel(wechatChatId),
    ))
  }

  const qq = qqBridgeManager.findChatBySessionId(sessionId)
  if (qq) {
    const botName = qqBridgeManager.listAllBindings().find((b) => b.botId === qq.botId)?.botName
    return toTarget(option('qq', qq.botId, qq.chatId, formatQQChatLabel(qq.chatId), botName))
  }

  return undefined
}
