/**
 * 定时任务完成通知投递服务。
 *
 * 两条腿：
 * 1. **本机系统通知，每次运行结束都发**（skipped 除外）——「跑完了」这件事本身就该
 *    让人知道，所以不做成逐任务开关，只受设置里的通知总开关约束。
 * 2. **远程渠道，可选一个**（飞书 / 微信 / QQ），按 trigger 决定成功、失败还是都推。
 *    远程推送失败时再补一条本机通知说明原因 —— 结果那条已经发过了，这条只解释
 *    远程为什么没到。
 */

import { Notification } from 'electron'
import type {
  Automation,
  AutomationNotificationTarget,
  AutomationRun,
} from '@proma/shared'
import { TRAY_IPC_CHANNELS } from '../../types'
import { getAgentSessionSDKMessages } from './agent-session-manager'
import { getMainWindow } from './main-window-store'
import { getSettings } from './settings-service'
import { feishuBridgeManager } from './feishu-bridge-manager'
import { wechatBridge } from './wechat-bridge'
import { qqBridgeManager } from './qq-bridge-manager'
import {
  AUTOMATION_CHANNEL_LABELS,
  buildAutomationFeishuCard,
  buildAutomationLocalNotification,
  buildAutomationTextNotification,
  extractAssistantText,
  shouldNotifyAutomationTarget,
} from './automation-notification-format'

interface AutomationNotificationPayload {
  automation: Automation
  run: AutomationRun
}

export async function notifyAutomationRunFinished(payload: AutomationNotificationPayload): Promise<void> {
  // 跳过的运行（来源会话忙等）不是结果，不打扰用户
  if (payload.run.status === 'skipped') return

  const summary = payload.run.status === 'success'
    ? extractAssistantText(getAgentSessionSDKMessages(payload.run.sessionId))
    : (payload.run.error ?? '未知错误')
  const detail = { ...payload, summary }

  showLocalNotification(detail)

  const target = (payload.automation.notificationTargets ?? []).find((item) =>
    shouldNotifyAutomationTarget(item, payload.run.status))
  if (!target) return

  try {
    await sendRemoteNotification(target, detail)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const platform = AUTOMATION_CHANNEL_LABELS[target.type] ?? target.type
    console.error(
      `[定时任务] ${platform}推送失败: automation=${payload.automation.id}, chat=${target.chatId}`,
      error,
    )
    showSystemNotification(
      `推送到${platform}失败`,
      `${payload.automation.name}\n${reason}`,
      payload.run.sessionId,
    )
  }
}

async function sendRemoteNotification(
  target: AutomationNotificationTarget,
  detail: AutomationNotificationPayload & { summary: string },
): Promise<void> {
  switch (target.type) {
    case 'feishu':
      await feishuBridgeManager.sendCardToChat(
        target.botId,
        target.chatId,
        buildAutomationFeishuCard(detail),
      )
      return
    case 'wechat':
      await wechatBridge.sendTextToChat(target.chatId, buildAutomationTextNotification(detail))
      return
    case 'qq':
      await qqBridgeManager.sendTextToChat(
        target.botId,
        target.chatId,
        buildAutomationTextNotification(detail),
      )
      return
  }
}

function showLocalNotification(detail: AutomationNotificationPayload & { summary: string }): void {
  const { title, body } = buildAutomationLocalNotification(detail)
  showSystemNotification(title, body, detail.run.sessionId)
}

/**
 * 发一条系统通知，点击后聚焦主窗口并打开对应会话。
 *
 * 与本地提醒（planning-reminder-scheduler）一致：通知由主进程发出，窗口隐藏或未
 * 聚焦时也不依赖渲染进程。
 */
function showSystemNotification(title: string, body: string, sessionId?: string): void {
  if (!getSettings().notificationsEnabled) {
    console.log(`[定时任务] 通知总开关已关闭，跳过本机通知: ${title}`)
    return
  }
  if (!Notification.isSupported()) return

  const notification = new Notification({ title, body, silent: true })
  notification.on('click', () => {
    const window = getMainWindow()
    if (!window) return
    window.show()
    window.focus()
    if (sessionId) {
      window.webContents.send(TRAY_IPC_CHANNELS.OPEN_AGENT_SESSION, { sessionId, title: '' })
    }
  })
  notification.show()
}
