/**
 * QQ 机器人配置管理
 *
 * 多 Bot 配置持久化到 ~/.proma/qq.json，AppSecret 用 safeStorage 加密后以
 * base64 存储。Bot ID 由 AppID 稳定派生（sha256 前 16 位），这样用户改名或改
 * 其它字段时 ID 不变、聊天绑定文件不会失联 —— 与钉钉 createStableDingTalkBotId
 * 的做法一致。
 */
import { safeStorage } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import type { QQBotConfig, QQBotConfigInput, QQMultiBotConfig } from '@proma/shared'
import { getQQBotBindingsPath, getQQConfigPath } from './config-paths'
import { redactSensitiveLogValue } from './bridge-log-redaction'

const BOT_ID_PREFIX = 'qq-'

/** 由 AppID 稳定派生 Bot ID；AppID 为空时返回 undefined，由调用方兜底 */
export function createStableQQBotId(appId: string): string | undefined {
  const normalized = appId.trim()
  if (!normalized) return undefined
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 16)
  return `${BOT_ID_PREFIX}${digest}`
}

function encryptSecret(plainSecret: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[QQ 配置] safeStorage 加密不可用，将以明文存储')
    return plainSecret
  }
  return safeStorage.encryptString(plainSecret).toString('base64')
}

function decryptSecret(encryptedSecret: string): string {
  if (!encryptedSecret) return ''
  if (!safeStorage.isEncryptionAvailable()) {
    return encryptedSecret
  }
  try {
    return safeStorage.decryptString(Buffer.from(encryptedSecret, 'base64'))
  } catch (error) {
    console.error('[QQ 配置] 解密 AppSecret 失败:', redactSensitiveLogValue(error))
    throw new Error('解密 AppSecret 失败')
  }
}

const EMPTY_CONFIG: QQMultiBotConfig = { version: 1, bots: [] }

function readRawConfig(): QQMultiBotConfig {
  const filePath = getQQConfigPath()
  if (!existsSync(filePath)) return { ...EMPTY_CONFIG, bots: [] }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<QQMultiBotConfig>
    return { version: 1, bots: Array.isArray(parsed.bots) ? parsed.bots : [] }
  } catch (error) {
    console.error('[QQ 配置] 读取失败，按空配置处理:', redactSensitiveLogValue(error))
    return { ...EMPTY_CONFIG, bots: [] }
  }
}

function writeConfig(config: QQMultiBotConfig): void {
  writeFileSync(getQQConfigPath(), JSON.stringify(config, null, 2), 'utf-8')
}

/** Bot ID 变化时把绑定文件一起改名，避免历史会话绑定失联 */
function migrateBindingFile(oldBotId: string, newBotId: string): void {
  const oldPath = getQQBotBindingsPath(oldBotId)
  const newPath = getQQBotBindingsPath(newBotId)
  if (oldBotId === newBotId || !existsSync(oldPath) || existsSync(newPath)) return
  try {
    renameSync(oldPath, newPath)
    console.log(`[QQ 配置] 绑定文件已迁移: ${oldBotId} → ${newBotId}`)
  } catch (error) {
    console.error('[QQ 配置] 绑定文件迁移失败:', redactSensitiveLogValue(error))
  }
}

function resolveBotId(appId: string, fallbackId?: string): string {
  return createStableQQBotId(appId) ?? fallbackId ?? randomUUID()
}

/** 读取多 Bot 配置 */
export function getQQMultiBotConfig(): QQMultiBotConfig {
  return readRawConfig()
}

/** 按 ID 取单个 Bot 配置 */
export function getQQBotById(botId: string): QQBotConfig | undefined {
  return readRawConfig().bots.find((b) => b.id === botId)
}

/** 保存单个 Bot（新建或更新），返回保存后的配置 */
export function saveQQBotConfig(input: QQBotConfigInput): QQBotConfig {
  const config = readRawConfig()
  const appId = input.appId.trim()

  if (input.id) {
    const idx = config.bots.findIndex((b) => b.id === input.id)
    if (idx === -1) throw new Error(`Bot ${input.id} 不存在`)
    const existing = config.bots[idx]!

    // AppID 改了会导致派生 ID 变化；若新 ID 与别的 Bot 冲突则保留原 ID
    const resolvedId = resolveBotId(appId, input.id)
    const nextId = config.bots.some((b, i) => i !== idx && b.id === resolvedId) ? input.id : resolvedId
    if (nextId !== input.id) migrateBindingFile(input.id, nextId)

    const updated: QQBotConfig = {
      id: nextId,
      name: input.name,
      enabled: input.enabled,
      appId,
      // 空字符串表示不修改，沿用已加密的旧值
      appSecret: input.appSecret ? encryptSecret(input.appSecret) : existing.appSecret,
      sandbox: input.sandbox,
      defaultWorkspaceId: input.defaultWorkspaceId,
      defaultChannelId: input.defaultChannelId,
      defaultModelId: input.defaultModelId,
    }
    config.bots[idx] = updated
    writeConfig(config)
    console.log(`[QQ 配置] Bot "${updated.name}" 已更新`)
    return updated
  }

  const bot: QQBotConfig = {
    id: resolveBotId(appId),
    name: input.name,
    enabled: input.enabled,
    appId,
    appSecret: input.appSecret ? encryptSecret(input.appSecret) : '',
    sandbox: input.sandbox,
    defaultWorkspaceId: input.defaultWorkspaceId,
    defaultChannelId: input.defaultChannelId,
    defaultModelId: input.defaultModelId,
  }
  config.bots.push(bot)
  writeConfig(config)
  console.log(`[QQ 配置] 新 Bot "${bot.name}" 已创建 (${bot.id})`)
  return bot
}

/** 删除 Bot */
export function removeQQBot(botId: string): boolean {
  const config = readRawConfig()
  const idx = config.bots.findIndex((b) => b.id === botId)
  if (idx === -1) return false
  const removed = config.bots.splice(idx, 1)[0]
  writeConfig(config)
  console.log(`[QQ 配置] Bot "${removed?.name}" 已删除`)
  return true
}

/** 取某个 Bot 的明文 AppSecret */
export function getDecryptedBotAppSecret(botId: string): string {
  const bot = getQQBotById(botId)
  if (!bot) throw new Error(`Bot ${botId} 不存在`)
  return decryptSecret(bot.appSecret)
}

/** 更新某个 Bot 的默认工作区（用户在聊天里切换工作区时回写） */
export function updateQQBotDefaultWorkspace(botId: string, workspaceId: string): void {
  const config = readRawConfig()
  const bot = config.bots.find((b) => b.id === botId)
  if (!bot || bot.defaultWorkspaceId === workspaceId) return
  bot.defaultWorkspaceId = workspaceId
  writeConfig(config)
}
