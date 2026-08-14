import { describe, expect, test } from 'bun:test'
import {
  buildTranslationSystemPrompt,
  DEFAULT_TRANSLATION_LANGUAGE,
  DEFAULT_TRANSLATION_PROMPT,
  getTranslationLanguage,
  TARGET_LANGUAGE_PLACEHOLDER,
  TRANSLATION_LANGUAGES,
} from './translation-prompt'

describe('翻译提示词', () => {
  test('given 模板含多处占位符 when 构造提示词 then 全部替换为目标语言', () => {
    const prompt = buildTranslationSystemPrompt(
      `翻译成${TARGET_LANGUAGE_PLACEHOLDER}；若已是${TARGET_LANGUAGE_PLACEHOLDER}则润色。`,
      '日语',
    )

    expect(prompt).toBe('翻译成日语；若已是日语则润色。')
    expect(prompt).not.toContain(TARGET_LANGUAGE_PLACEHOLDER)
  })

  test('given 用户把占位符删掉 when 构造提示词 then 追加目标语言行', () => {
    // 没有这条兜底，下拉框看着还在工作，实际模型不知道要翻成什么语言。
    const prompt = buildTranslationSystemPrompt('只输出译文，不要解释。', '英语')

    expect(prompt).toBe('只输出译文，不要解释。\n\n目标语言：英语')
  })

  test('given 模板为空白 when 构造提示词 then 回退到默认提示词并代入语言', () => {
    const prompt = buildTranslationSystemPrompt('   \n  ', '中文')

    expect(prompt).toContain('专业翻译')
    expect(prompt).toContain('翻译成中文')
    expect(prompt).not.toContain(TARGET_LANGUAGE_PLACEHOLDER)
  })

  test('默认提示词保留占位符并明确要求保持分段', () => {
    expect(DEFAULT_TRANSLATION_PROMPT).toContain(TARGET_LANGUAGE_PLACEHOLDER)
    expect(DEFAULT_TRANSLATION_PROMPT).toContain('分段')
  })

  test('语言表为中英日三项且 code 唯一', () => {
    const codes = TRANSLATION_LANGUAGES.map((item) => item.code)

    expect(codes).toEqual(['zh', 'en', 'ja'])
    expect(new Set(codes).size).toBe(codes.length)
    expect(DEFAULT_TRANSLATION_LANGUAGE).toBe('zh')
  })

  test('given 未知语言 code when 查询 then 回退到默认语言', () => {
    expect(getTranslationLanguage('ko').code).toBe('zh')
    expect(getTranslationLanguage('ja').label).toBe('日语')
  })
})
