/**
 * useGlobalTranslationListeners — 全局翻译 IPC 监听器（Pioneer fork 自有）
 *
 * 在应用顶层挂载，永不销毁。TabContent 只渲染当前激活 Tab，
 * 翻译视图会随切 Tab 卸载，监听器必须挂在这里，否则切到草稿再切回来
 * 流式输出就断了。参照 useGlobalChatListeners 的写法。
 */

import { useEffect } from 'react'
import { useStore } from 'jotai'
import {
  translationErrorAtom,
  translationOutputAtom,
  translationRequestIdAtom,
  translationStreamingAtom,
} from '@/atoms/translation-atoms'

export function useGlobalTranslationListeners(): void {
  const store = useStore()

  useEffect(() => {
    /** 过期流拦截：用户连点翻译或翻译中换模型时，旧流的 chunk 不能污染新结果。 */
    const isStale = (requestId: string): boolean =>
      store.get(translationRequestIdAtom) !== requestId

    const unsubscribeChunk = window.electronAPI.onTranslationChunk((event) => {
      if (isStale(event.requestId)) return
      store.set(translationOutputAtom, (prev) => prev + event.delta)
    })

    const unsubscribeComplete = window.electronAPI.onTranslationComplete((event) => {
      if (isStale(event.requestId)) return
      store.set(translationStreamingAtom, false)
      store.set(translationRequestIdAtom, null)
    })

    const unsubscribeError = window.electronAPI.onTranslationError((event) => {
      if (isStale(event.requestId)) return
      store.set(translationStreamingAtom, false)
      store.set(translationRequestIdAtom, null)
      store.set(translationErrorAtom, event.error)
    })

    return () => {
      unsubscribeChunk()
      unsubscribeComplete()
      unsubscribeError()
    }
  }, [store])
}
