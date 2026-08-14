/**
 * TranslateView — 翻译标签页（Pioneer fork 自有）
 *
 * 顶部一行：目标语言 + 翻译按钮 | 模型选择 + 设置齿轮
 * 主体：左输原文，右流式出译文并渲染 Markdown。
 *
 * 不建会话、不落盘：状态全在 translation-atoms 里，
 * 关掉 App 只留下偏好（目标语言 / 模型 / 提示词 / 思考开关）。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Languages, Settings, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { LoadingIndicator } from '@/components/ui/loading-indicator'
import { MessageResponse, remarkPreserveBreaks } from '@/components/ai-elements/message'
import type { RemarkPluginFn } from '@/components/ai-elements/message'
import { CopyButton } from '@/components/chat/CopyButton'
import { ModelSelector, buildModelOptions } from '@/components/chat/ModelSelector'
import { channelsAtom, selectedModelAtom } from '@/atoms/chat-atoms'
import type { SelectedModel } from '@/atoms/chat-atoms'
import {
  translationErrorAtom,
  translationInputAtom,
  translationModelAtom,
  translationOutputAtom,
  translationPromptAtom,
  translationRequestIdAtom,
  translationStreamingAtom,
  translationTargetLanguageAtom,
  translationThinkingEnabledAtom,
} from '@/atoms/translation-atoms'
import {
  buildTranslationSystemPrompt,
  getTranslationLanguage,
  TRANSLATION_LANGUAGES,
} from '@/lib/translation-prompt'
import type { TranslationLanguageCode } from '@/types/translation'
import { LanguageFlag } from './flag-icons'
import { TranslateSettingsDialog } from './TranslateSettingsDialog'

/** 订阅制 OAuth 渠道走 Pi 专用传输层，这套 provider 适配器接不上（与 Chat 同源限制）。 */
const EXCLUDED_PROVIDERS = ['openai-codex', 'xai'] as const

/**
 * 译文渲染必须带 remarkPreserveBreaks。
 *
 * Markdown 规范里**单个换行不算换行**，会被合并进同一段落 —— 模型按原文输出了 `\n`，
 * 但 MessageResponse 的默认插件集（remarkGfm + remarkMath）会把它吃掉，
 * 表现为「原文分了行、译文糊成一大段」，且换任何模型都一样。
 * 只有模型恰好多打一个空行时那一处才会断开，所以现象看着像模型时好时坏。
 *
 * 翻译的输入是手输/粘贴的纯文本，与用户消息同类，所以复用用户消息那条插件
 * （见 message.tsx 的 USER_REMARK_PLUGINS），它会跳过代码块，不影响围栏内的原样输出。
 */
const TRANSLATION_REMARK_PLUGINS: RemarkPluginFn[] = [remarkPreserveBreaks]

export function TranslateView(): React.ReactElement {
  const [targetLanguage, setTargetLanguage] = useAtom(translationTargetLanguageAtom)
  const [translationModel, setTranslationModel] = useAtom(translationModelAtom)
  const [input, setInput] = useAtom(translationInputAtom)
  const output = useAtomValue(translationOutputAtom)
  const streaming = useAtomValue(translationStreamingAtom)
  const error = useAtomValue(translationErrorAtom)
  const prompt = useAtomValue(translationPromptAtom)
  const thinkingEnabled = useAtomValue(translationThinkingEnabledAtom)
  const requestId = useAtomValue(translationRequestIdAtom)

  const setOutput = useSetAtom(translationOutputAtom)
  const setStreaming = useSetAtom(translationStreamingAtom)
  const setError = useSetAtom(translationErrorAtom)
  const setRequestId = useSetAtom(translationRequestIdAtom)

  const channels = useAtomValue(channelsAtom)
  const chatModel = useAtomValue(selectedModelAtom)
  const [settingsOpen, setSettingsOpen] = React.useState(false)

  /**
   * 翻译用的模型：自己选过就用自己的，否则回退到 Chat 的默认模型，
   * 再不行取第一个可用模型。在此处选择只写 translationModelAtom，
   * 不污染 Chat 的全局选择。
   */
  const effectiveModel: SelectedModel | null = React.useMemo(() => {
    const options = buildModelOptions(channels, undefined, undefined, EXCLUDED_PROVIDERS)
    const isUsable = (model: SelectedModel | null): boolean =>
      !!model && options.some((o) => o.channelId === model.channelId && o.modelId === model.modelId)

    if (isUsable(translationModel)) return translationModel
    if (isUsable(chatModel)) return chatModel
    const first = options[0]
    return first ? { channelId: first.channelId, modelId: first.modelId } : null
  }, [channels, translationModel, chatModel])

  const canTranslate = input.trim().length > 0 && !!effectiveModel

  const handleTranslate = React.useCallback(() => {
    if (!canTranslate || !effectiveModel) return

    const nextRequestId = crypto.randomUUID()
    setRequestId(nextRequestId)
    setOutput('')
    setError(null)
    setStreaming(true)

    const languageLabel = getTranslationLanguage(targetLanguage).label
    window.electronAPI.translate({
      requestId: nextRequestId,
      text: input,
      channelId: effectiveModel.channelId,
      modelId: effectiveModel.modelId,
      systemPrompt: buildTranslationSystemPrompt(prompt, languageLabel),
      thinkingEnabled,
    }).catch((err: unknown) => {
      console.error('[翻译] 发起请求失败:', err)
      setStreaming(false)
      setRequestId(null)
      setError(err instanceof Error ? err.message : '发起翻译失败')
    })
  }, [
    canTranslate, effectiveModel, input, prompt, targetLanguage, thinkingEnabled,
    setError, setOutput, setRequestId, setStreaming,
  ])

  const handleStop = React.useCallback(() => {
    if (!requestId) return
    window.electronAPI.stopTranslation(requestId).catch(console.error)
  }, [requestId])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶部操作行 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-4 py-2.5">
        <Select
          value={targetLanguage}
          onValueChange={(value) => setTargetLanguage(value as TranslationLanguageCode)}
        >
          <SelectTrigger className="h-8 w-[128px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TRANSLATION_LANGUAGES.map((language) => (
              <SelectItem key={language.code} value={language.code} className="text-xs">
                <span className="flex items-center gap-2">
                  <LanguageFlag code={language.code} />
                  {language.label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {streaming ? (
          <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5" onClick={handleStop}>
            <Square className="size-3 fill-current" />
            停止
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            className="h-8 gap-1.5"
            disabled={!canTranslate}
            onClick={handleTranslate}
          >
            <Languages className="size-3.5" />
            翻译
          </Button>
        )}

        <div className="flex-1" />

        <ModelSelector
          externalSelectedModel={effectiveModel}
          excludedProviders={EXCLUDED_PROVIDERS}
          onModelSelect={(option) => setTranslationModel({
            channelId: option.channelId,
            modelId: option.modelId,
          })}
        />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings className="size-3.5" />
              <span className="sr-only">翻译设置</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">翻译设置</TooltipContent>
        </Tooltip>
      </div>

      {/* 原文 / 译文左右对称 */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <PaneHeader label="原文" copyContent={input} />
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="在这里输入或粘贴要翻译的内容…"
            spellCheck={false}
            className="flex-1 min-h-0 w-full resize-none bg-transparent px-4 py-3 text-sm leading-[1.7] outline-none placeholder:text-muted-foreground/60 scrollbar-thin"
          />
        </div>

        <div className="w-px shrink-0 self-stretch bg-border/60" />

        <div className="flex min-w-0 flex-1 flex-col">
          <PaneHeader
            label={`译文 · ${getTranslationLanguage(targetLanguage).label}`}
            copyContent={output}
          />
          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 scrollbar-thin">
            {error && (
              <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            )}
            {streaming && !output ? (
              <LoadingIndicator label="正在翻译" showElapsed />
            ) : output ? (
              <MessageResponse remarkPlugins={TRANSLATION_REMARK_PLUGINS}>{output}</MessageResponse>
            ) : !error ? (
              <p className="text-sm text-muted-foreground/60">译文会显示在这里。</p>
            ) : null}
          </div>
        </div>
      </div>

      <TranslateSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  )
}

/**
 * 分栏标题行：左侧标签，右上角复制按钮。
 *
 * 复制按钮只在有内容时出现，标题行用 min-h 固定高度，避免出现/消失时布局跳动。
 * 复用 CopyButton（已带 Copy→Check 反馈与主进程剪贴板兜底），不另写一套。
 */
function PaneHeader({
  label,
  copyContent,
}: {
  label: string
  copyContent: string
}): React.ReactElement {
  return (
    <div className="flex min-h-[30px] shrink-0 items-center justify-between gap-2 pl-4 pr-2 pt-1.5">
      <span className="min-w-0 truncate text-[11px] font-medium tracking-wide text-muted-foreground/70">
        {label}
      </span>
      {copyContent.trim().length > 0 && <CopyButton content={copyContent} />}
    </div>
  )
}
