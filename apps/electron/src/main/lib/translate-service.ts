/**
 * 翻译流式服务（Pioneer fork 自有）
 *
 * 与 chat-service 共用 @proma/core 的 provider 适配器和 SSE 读取器，
 * 但刻意不做 chat-service 的那一整套：不建对话、不写 JSONL、不更新索引、
 * 不生成标题、不落任何盘。翻译是一次性动作，结果只存在于渲染进程内存里。
 *
 * 思考内容按产品决定不展示，所以 reasoning 事件直接丢弃，不额外开 IPC 通道。
 */

import type { WebContents } from 'electron'
import { getAdapter, streamSSE } from '@proma/core'
import { TRANSLATION_IPC_CHANNELS } from '../../types'
import type { TranslationRequestInput } from '../../types'
import { listChannels, resolveChannelRuntimeApiKey } from './channel-manager'
import { getFetchFn } from './proxy-fetch'
import { getEffectiveProxyUrl } from './proxy-settings-service'

/** 活跃的 AbortController 映射（requestId → controller） */
const activeControllers = new Map<string, AbortController>()

function sendError(webContents: WebContents, requestId: string, error: string): void {
  if (webContents.isDestroyed()) return
  webContents.send(TRANSLATION_IPC_CHANNELS.STREAM_ERROR, { requestId, error })
}

/**
 * 执行一次翻译并流式回传译文。
 *
 * @param input 翻译参数（systemPrompt 已由渲染层代入目标语言）
 * @param webContents 发起请求的渲染进程
 */
export async function translate(
  input: TranslationRequestInput,
  webContents: WebContents,
): Promise<void> {
  const { requestId, text, channelId, modelId, systemPrompt, thinkingEnabled } = input

  const channel = listChannels().find((c) => c.id === channelId)
  if (!channel) {
    sendError(webContents, requestId, '渠道不存在')
    return
  }

  // 与 Chat 同源限制：订阅制 OAuth 走 Pi 专用传输层，这套适配器接不上。
  // 渲染层的模型选择器已排除这两类渠道，这里是持久化了旧选择时的兜底。
  if (channel.provider === 'openai-codex' || channel.provider === 'xai') {
    const providerName = channel.provider === 'xai' ? 'xAI（Grok OAuth）' : 'ChatGPT 订阅（Codex OAuth）'
    sendError(webContents, requestId, `翻译暂不支持 ${providerName}，请换一个 API Key 渠道。`)
    return
  }

  let apiKey: string
  try {
    apiKey = await resolveChannelRuntimeApiKey(channelId)
  } catch {
    sendError(webContents, requestId, '解密 API Key 失败')
    return
  }

  const controller = new AbortController()
  activeControllers.set(requestId, controller)

  try {
    const adapter = getAdapter(channel.provider)
    const proxyUrl = await getEffectiveProxyUrl()
    const fetchFn = getFetchFn(proxyUrl)

    const request = adapter.buildStreamRequest({
      baseUrl: channel.baseUrl,
      apiKey,
      modelId,
      // 翻译无上下文、无附件：每次都是独立的一轮。
      history: [],
      userMessage: text,
      systemMessage: systemPrompt,
      readImageAttachments: () => [],
      thinkingEnabled,
    })

    await streamSSE({
      request,
      adapter,
      signal: controller.signal,
      fetchFn,
      onEvent: (event) => {
        // 只透传正文；reasoning 按产品决定不展示，在这里就丢掉。
        if (event.type !== 'chunk' || !event.delta) return
        if (webContents.isDestroyed()) return
        webContents.send(TRANSLATION_IPC_CHANNELS.STREAM_CHUNK, {
          requestId,
          delta: event.delta,
        })
      },
    })

    if (!webContents.isDestroyed()) {
      webContents.send(TRANSLATION_IPC_CHANNELS.STREAM_COMPLETE, { requestId })
    }
  } catch (error) {
    // 用户主动中止：已输出的译文留在界面上，按正常完成收尾。
    if (controller.signal.aborted) {
      console.log(`[翻译服务] 请求 ${requestId} 已被用户中止`)
      if (!webContents.isDestroyed()) {
        webContents.send(TRANSLATION_IPC_CHANNELS.STREAM_COMPLETE, { requestId, aborted: true })
      }
      return
    }

    const message = error instanceof Error ? error.message : '未知错误'
    console.error('[翻译服务] 流式请求失败:', error)
    sendError(webContents, requestId, message)
  } finally {
    activeControllers.delete(requestId)
  }
}

/** 中止指定翻译请求 */
export function stopTranslation(requestId: string): void {
  const controller = activeControllers.get(requestId)
  if (!controller) return
  controller.abort()
  activeControllers.delete(requestId)
  console.log(`[翻译服务] 已中止请求: ${requestId}`)
}

/** 中止所有活跃翻译（应用退出时调用） */
export function stopAllTranslations(): void {
  if (activeControllers.size === 0) return
  console.log(`[翻译服务] 正在中止所有活跃翻译 (${activeControllers.size} 个)...`)
  for (const controller of activeControllers.values()) {
    controller.abort()
  }
  activeControllers.clear()
}
