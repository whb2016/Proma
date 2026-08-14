/**
 * 翻译标签页类型（Pioneer fork 自有）
 *
 * 翻译走独立的极薄流式链路，不复用 Chat 的发送路径：
 * chat-service.sendMessage 会建对话、写 JSONL、更新索引、生成标题，
 * 而翻译是一次性动作，不应留下任何会话数据。
 *
 * 放在 src/types/ 下是为了三端都能取到同一份定义：
 * 主进程 `'../../types'`、preload `'../types'`、渲染进程 `@/types/translation`。
 */

/** 支持的目标语言代码 */
export const TRANSLATION_LANGUAGE_CODES = ['zh', 'en', 'ja'] as const

/** 目标语言代码 */
export type TranslationLanguageCode = (typeof TRANSLATION_LANGUAGE_CODES)[number]

/** 翻译 IPC 通道 */
export const TRANSLATION_IPC_CHANNELS = {
  /** 发起翻译（触发流式响应） */
  TRANSLATE: 'translation:translate',
  /** 中止指定翻译请求 */
  STOP: 'translation:stop',
  /** 译文片段 */
  STREAM_CHUNK: 'translation:stream:chunk',
  /** 流式完成（含用户主动中止） */
  STREAM_COMPLETE: 'translation:stream:complete',
  /** 流式错误 */
  STREAM_ERROR: 'translation:stream:error',
} as const

/** 发起翻译的入参 */
export interface TranslationRequestInput {
  /**
   * 本次请求 ID，每次点击翻译重新生成。
   *
   * 渲染层据此丢弃过期流：用户连点翻译或翻译中换模型时，
   * 没有它旧流的 chunk 会继续追加进新结果里。
   */
  requestId: string
  /** 待翻译原文 */
  text: string
  /** 渠道 ID */
  channelId: string
  /** 模型 ID */
  modelId: string
  /** 已代入目标语言的完整系统提示词（由渲染层构造，用户可编辑） */
  systemPrompt: string
  /** 是否开启思考；思考内容不回传渲染层 */
  thinkingEnabled: boolean
}

/** 译文片段事件 */
export interface TranslationStreamChunkEvent {
  requestId: string
  delta: string
}

/** 翻译完成事件 */
export interface TranslationStreamCompleteEvent {
  requestId: string
  /** 是否因用户主动中止而结束 */
  aborted?: boolean
}

/** 翻译错误事件 */
export interface TranslationStreamErrorEvent {
  requestId: string
  error: string
}
