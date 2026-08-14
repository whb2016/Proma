/**
 * 翻译提示词与目标语言定义（Pioneer fork 自有）
 *
 * 纯逻辑，无 React 依赖，便于单测。
 */

import type { TranslationLanguageCode } from '@/types/translation'

/** 提示词里代表目标语言的占位符 */
export const TARGET_LANGUAGE_PLACEHOLDER = '{{targetLanguage}}'

/**
 * 默认翻译提示词。
 *
 * 两条硬要求：目标语言由 {{targetLanguage}} 注入；译文必须保持原文的分段结构
 * —— 模型默认倾向于把短段落合并、把换行抹平，不显式禁止就一定会发生。
 */
export const DEFAULT_TRANSLATION_PROMPT = `你是一名专业翻译。把用户消息中的全部内容翻译成${TARGET_LANGUAGE_PLACEHOLDER}。

要求：
- 只输出译文本身。不要解释，不要复述原文，不要加任何前言、后记或"以下是译文"之类的说明。
- 严格保持原文的分段与换行结构：原文有几段，译文就有几段，空行的位置和数量保持一致，不合并段落也不拆分段落。
- 保留原文的 Markdown 结构与标记：标题层级、列表符号与编号、引用、表格、加粗与斜体、行内代码、链接。
- 代码块内容、命令、URL、文件路径、变量名、以及专有名词的英文缩写保持原样，不翻译。
- 全文术语翻译保持一致。
- 遇到无法确定的人名、产品名，保留原文写法。
- 如果原文已经是${TARGET_LANGUAGE_PLACEHOLDER}，则润色为地道自然的${TARGET_LANGUAGE_PLACEHOLDER}表达，同样只输出结果。`

/** 目标语言选项 */
export interface TranslationLanguageOption {
  code: TranslationLanguageCode
  /** 下拉框显示名，同时代入提示词 */
  label: string
}

/** 支持的目标语言，顺序即下拉框顺序 */
export const TRANSLATION_LANGUAGES: readonly TranslationLanguageOption[] = [
  { code: 'zh', label: '中文' },
  { code: 'en', label: '英语' },
  { code: 'ja', label: '日语' },
]

/** 默认目标语言 */
export const DEFAULT_TRANSLATION_LANGUAGE: TranslationLanguageCode = 'zh'

/** 按 code 取语言选项，未知 code 回退到默认语言 */
export function getTranslationLanguage(code: string): TranslationLanguageOption {
  return TRANSLATION_LANGUAGES.find((item) => item.code === code)
    ?? TRANSLATION_LANGUAGES.find((item) => item.code === DEFAULT_TRANSLATION_LANGUAGE)!
}

/**
 * 把目标语言代入提示词模板。
 *
 * 用户可以自由编辑提示词，包括把占位符删掉。占位符缺失时必须补一行目标语言 ——
 * 否则下拉框看起来仍在工作，实际上模型完全不知道要翻成什么语言。
 */
export function buildTranslationSystemPrompt(template: string, languageLabel: string): string {
  const trimmed = template.trim()
  const base = trimmed || DEFAULT_TRANSLATION_PROMPT

  if (base.includes(TARGET_LANGUAGE_PLACEHOLDER)) {
    return base.split(TARGET_LANGUAGE_PLACEHOLDER).join(languageLabel)
  }

  return `${base}\n\n目标语言：${languageLabel}`
}
