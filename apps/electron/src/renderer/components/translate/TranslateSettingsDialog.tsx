/**
 * TranslateSettingsDialog — 翻译设置弹窗（Pioneer fork 自有）
 *
 * 两项：可编辑的翻译提示词（保存 / 重置为默认），以及思考开关。
 */

import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { RotateCcw, Save } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import {
  translationPromptAtom,
  translationTargetLanguageAtom,
  translationThinkingEnabledAtom,
} from '@/atoms/translation-atoms'
import {
  DEFAULT_TRANSLATION_PROMPT,
  getTranslationLanguage,
  TARGET_LANGUAGE_PLACEHOLDER,
} from '@/lib/translation-prompt'

export function TranslateSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.ReactElement {
  const [prompt, setPrompt] = useAtom(translationPromptAtom)
  const [thinkingEnabled, setThinkingEnabled] = useAtom(translationThinkingEnabledAtom)
  const targetLanguage = useAtomValue(translationTargetLanguageAtom)
  const languageLabel = getTranslationLanguage(targetLanguage).label

  const [draft, setDraft] = React.useState(prompt)

  // 每次打开都从已保存值重置草稿，避免上次未保存的编辑残留下来。
  React.useEffect(() => {
    if (open) setDraft(prompt)
  }, [open, prompt])

  const isDirty = draft !== prompt
  const isDefault = draft === DEFAULT_TRANSLATION_PROMPT

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>翻译设置</DialogTitle>
          <DialogDescription>
            提示词与思考开关只作用于翻译标签页，不影响 Chat 和 Agent。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="translation-prompt" className="text-sm font-medium">
                翻译提示词
              </Label>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 px-2 text-xs"
                  disabled={isDefault && !isDirty}
                  onClick={() => setDraft(DEFAULT_TRANSLATION_PROMPT)}
                >
                  <RotateCcw className="size-3.5" />
                  重置
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-7 gap-1.5 px-3 text-xs"
                  disabled={!isDirty}
                  onClick={() => setPrompt(draft)}
                >
                  <Save className="size-3.5" />
                  保存
                </Button>
              </div>
            </div>

            <Textarea
              id="translation-prompt"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              spellCheck={false}
              className="min-h-[260px] font-mono text-xs leading-relaxed"
            />

            <p className="text-xs text-muted-foreground">
              <code className="rounded bg-muted px-1 py-0.5">{TARGET_LANGUAGE_PLACEHOLDER}</code>
              {' '}会被替换成当前选择的目标语言（现在是{languageLabel}）。
              若删掉该占位符，目标语言会自动追加到提示词末尾。
            </p>
          </section>

          <section className="flex items-start justify-between gap-6 rounded-lg border border-border/60 px-4 py-3">
            <div className="space-y-1">
              <Label htmlFor="translation-thinking" className="text-sm font-medium">
                开启思考
              </Label>
              <p className="text-xs text-muted-foreground">
                让模型在给出译文前先推理，长句和专业内容更准，但更慢。思考过程不会展示。
              </p>
            </div>
            <Switch
              id="translation-thinking"
              checked={thinkingEnabled}
              onCheckedChange={setThinkingEnabled}
            />
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
