/**
 * QQ 多 Bot 管理器
 *
 * botId → Bridge 实例。启动单个 Bot 时复用已有实例（保留 commandHandler 里的
 * 聊天绑定），只重建连接 —— 与钉钉管理器的做法一致。
 */
import type { QQBotBridgeState, QQBridgeState, QQMultiBridgeState, QQTestResult } from '@proma/shared'
import { QQBridge } from './qq-bridge'
import { getDecryptedBotAppSecret, getQQBotById, getQQMultiBotConfig } from './qq-config'
import { getQQBotBindingsPath } from './config-paths'
import { isBindingForDeletedWorkspace, loadBridgeChatBindings, saveBridgeChatBindings } from './bridge-binding-store'
import { redactSensitiveLogValue } from './bridge-log-redaction'

class QQBridgeManager {
  private bridges = new Map<string, QQBridge>()

  // ===== 生命周期 =====

  /** 启动所有已启用且凭证完整的 Bot */
  async startAll(): Promise<void> {
    const enabledBots = getQQMultiBotConfig().bots.filter((b) => b.enabled && b.appId && b.appSecret)

    for (const bot of enabledBots) {
      try {
        await this.startBot(bot.id)
      } catch (error) {
        console.error(`[QQ BridgeManager] Bot "${bot.name}" 启动失败:`, redactSensitiveLogValue(error))
      }
    }

    if (enabledBots.length > 0) {
      console.log(`[QQ BridgeManager] 已启动 ${this.bridges.size}/${enabledBots.length} 个 Bot`)
    }
  }

  stopAll(): void {
    for (const [botId, bridge] of this.bridges) {
      try {
        bridge.stop()
      } catch (error) {
        console.error(`[QQ BridgeManager] Bot ${botId} 停止失败:`, redactSensitiveLogValue(error))
      }
    }
    this.bridges.clear()
    console.log('[QQ BridgeManager] 所有 Bot 已停止')
  }

  async startBot(botId: string): Promise<void> {
    const botConfig = getQQBotById(botId)
    if (!botConfig) throw new Error(`Bot ${botId} 不存在`)
    if (!botConfig.enabled) throw new Error(`Bot "${botConfig.name}" 未启用`)

    // 复用实例以保留聊天绑定，只重建连接
    const existing = this.bridges.get(botId)
    if (existing) {
      existing.stop()
      existing.updateConfig(botConfig)
      await existing.start()
      return
    }

    const bridge = new QQBridge(botConfig)
    this.bridges.set(botId, bridge)
    await bridge.start()
  }

  stopBot(botId: string): void {
    const bridge = this.bridges.get(botId)
    if (!bridge) return
    bridge.stop()
    this.bridges.delete(botId)
  }

  /** 配置变更后重启（复用实例保留绑定） */
  async restartBot(botId: string): Promise<void> {
    await this.startBot(botId)
  }

  /** 自愈：把处于 error 状态且配置完整的 Bot 重新拉起 */
  async recoverEnabledBots(): Promise<void> {
    const states = this.getStates()
    for (const bot of getQQMultiBotConfig().bots) {
      if (!bot.enabled || !bot.appId || !bot.appSecret) continue
      if (states.bots[bot.id]?.status !== 'error') continue
      try {
        await this.startBot(bot.id)
      } catch (error) {
        console.error(`[QQ BridgeManager] Bot "${bot.name}" 自愈失败:`, redactSensitiveLogValue(error))
      }
    }
  }

  // ===== 状态查询 =====

  getStates(): QQMultiBridgeState {
    const bots: Record<string, QQBotBridgeState> = {}
    for (const bot of getQQMultiBotConfig().bots) {
      const status: QQBridgeState = this.bridges.get(bot.id)?.getStatus() ?? { status: 'disconnected' }
      bots[bot.id] = { ...status, botId: bot.id, botName: bot.name }
    }
    return { bots }
  }

  getBridge(botId: string): QQBridge | undefined {
    return this.bridges.get(botId)
  }

  /**
   * 清理已删除项目的聊天绑定
   *
   * 活跃 Bot 交给各自的 handler 同步内存与文件；未启动的 Bot 直接改持久化文件。
   */
  removeBindingsForDeletedWorkspace(workspaceId: string, sessionIds: Iterable<string>): number {
    const deletedSessionIds = new Set(sessionIds)
    let removedCount = 0

    for (const bridge of this.bridges.values()) {
      removedCount += bridge.removeBindingsForDeletedWorkspace(workspaceId, deletedSessionIds)
    }

    for (const bot of getQQMultiBotConfig().bots) {
      if (this.bridges.has(bot.id)) continue

      const filePath = getQQBotBindingsPath(bot.id)
      const label = `QQ Bridge/${bot.name}`
      const bindings = loadBridgeChatBindings(filePath, label)
      const retained = bindings.filter((binding) => !isBindingForDeletedWorkspace(binding, workspaceId, deletedSessionIds))
      if (retained.length === bindings.length) continue

      saveBridgeChatBindings(filePath, retained, label)
      removedCount += bindings.length - retained.length
    }

    return removedCount
  }

  // ===== 连接测试（不影响运行中的 Bridge） =====

  /**
   * 验证凭证
   *
   * appSecret 为空表示沿用已保存的密文（编辑时用户没改密码框），此时从配置解密取。
   */
  async testConnection(appId: string, appSecret: string, sandbox: boolean, botId?: string): Promise<QQTestResult> {
    try {
      const secret = appSecret || (botId ? getDecryptedBotAppSecret(botId) : '')
      if (!appId || !secret) {
        return { success: false, message: '请先填写 AppID 与 AppSecret' }
      }
      await QQBridge.testConnection(appId, secret, sandbox)
      return { success: true, message: '连接成功，凭证有效' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, message }
    }
  }
}

export const qqBridgeManager = new QQBridgeManager()
