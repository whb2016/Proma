/**
 * 翻译标签页状态（Pioneer fork 自有）
 *
 * 偏好走 localStorage（与 selectedModelAtom / sidebarCollapsedAtom 同一套路），
 * 不进 settings.json —— 这样 AppSettings 与 settings-service 一行都不用改。
 *
 * 运行期状态用普通 atom：TabContent 只渲染当前激活 Tab，翻译组件会随切 Tab 卸载，
 * 状态必须留在 atom 里才能切走再切回时接着看流式输出。
 */

import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type { TranslationLanguageCode } from '@/types/translation'
import type { SelectedModel } from './chat-atoms'
import { DEFAULT_TRANSLATION_LANGUAGE, DEFAULT_TRANSLATION_PROMPT } from '@/lib/translation-prompt'

// ===== 持久化偏好 =====

/** 目标语言，默认中文 */
export const translationTargetLanguageAtom = atomWithStorage<TranslationLanguageCode>(
  'proma-translation-target-language',
  DEFAULT_TRANSLATION_LANGUAGE,
)

/** 翻译专用模型；null 表示尚未选择，由视图回退到 Chat 的默认模型 */
export const translationModelAtom = atomWithStorage<SelectedModel | null>(
  'proma-translation-model',
  null,
)

/** 用户可编辑的翻译提示词模板 */
export const translationPromptAtom = atomWithStorage<string>(
  'proma-translation-prompt',
  DEFAULT_TRANSLATION_PROMPT,
)

/** 是否开启思考，默认关闭 */
export const translationThinkingEnabledAtom = atomWithStorage<boolean>(
  'proma-translation-thinking-enabled',
  false,
)

// ===== 运行期状态 =====

/** 左侧原文输入 */
export const translationInputAtom = atom<string>('')

/** 右侧译文（流式累积） */
export const translationOutputAtom = atom<string>('')

/** 是否正在翻译 */
export const translationStreamingAtom = atom<boolean>(false)

/** 翻译错误信息 */
export const translationErrorAtom = atom<string | null>(null)

/**
 * 当前请求 ID；null 表示无进行中的请求。
 * 全局监听器用它丢弃过期流（连点翻译、翻译中换模型都会产生过期流）。
 */
export const translationRequestIdAtom = atom<string | null>(null)
