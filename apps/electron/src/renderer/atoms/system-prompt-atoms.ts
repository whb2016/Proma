/**
 * System Prompt Atoms - 系统提示词状态管理
 *
 * 管理 Chat 模式的系统提示词配置，包括：
 * - 提示词列表和配置
 * - 当前选中的提示词
 * - 解析后的最终 systemMessage
 */

import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import {
  BUILTIN_DEFAULT_ID,
  BUILTIN_DEFAULT_PROMPT,
} from '@proma/shared'
import type { SystemPromptConfig, SystemPrompt } from '@proma/shared'
import { userProfileAtom } from './user-profile'

/** 提示词编辑侧栏是否打开 */
export const promptSidebarOpenAtom = atom<boolean>(false)

/** 完整提示词配置（从主进程加载） */
export const promptConfigAtom = atom<SystemPromptConfig>({
  prompts: [BUILTIN_DEFAULT_PROMPT],
  defaultPromptId: BUILTIN_DEFAULT_ID,
  appendDateTimeAndUserName: true,
})

/** 当前选中的提示词 ID（持久化到 localStorage） */
export const selectedPromptIdAtom = atomWithStorage<string>(
  'proma-selected-system-prompt-id',
  BUILTIN_DEFAULT_ID
)

/** 提示词列表（派生只读） */
export const promptListAtom = atom<SystemPrompt[]>(
  (get) => get(promptConfigAtom).prompts
)

/** 默认提示词 ID（派生只读） */
export const defaultPromptIdAtom = atom<string | undefined>(
  (get) => get(promptConfigAtom).defaultPromptId
)

/** 当前选中的提示词对象（派生只读） */
export const selectedPromptAtom = atom<SystemPrompt | undefined>((get) => {
  const config = get(promptConfigAtom)
  const selectedId = get(selectedPromptIdAtom)
  return config.prompts.find((p) => p.id === selectedId)
})

/**
 * 拼接日期与用户名的附加段
 *
 * **精度只到「日」，不能带时分**：这段拼在系统提示词末尾，而 Anthropic 的提示词缓存
 * 是前缀匹配、渲染顺序为 `tools → system → messages`。带上分钟的话，分钟一跳整段前缀
 * 就作废，多轮追问永远吃不到缓存，而且任何消息侧的断点都救不回来（它们都排在 system
 * 之后）。降到日期后前缀能稳一整天。见 [[chat-prompt-caching-notes]]。
 *
 * 需要模型知道精确时刻的场景（定时任务、Agent）走各自的注入链路，不依赖这里 ——
 * Agent 侧是按每条用户消息注入（agent-prompt-builder.ts 的 buildDynamicContext）。
 */
function buildDateAndUserNameAppendix(userName: string): string {
  const dateStr = new Date().toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
  })
  return `\n\n---\n当前日期: ${dateStr}\n用户名: ${userName}`
}

/** 解析最终 systemMessage（派生只读） */
export const resolvedSystemMessageAtom = atom<string | undefined>((get) => {
  const selectedPrompt = get(selectedPromptAtom)
  if (!selectedPrompt) return undefined

  let message = selectedPrompt.content

  const config = get(promptConfigAtom)
  if (config.appendDateTimeAndUserName) {
    const userProfile = get(userProfileAtom)
    message += buildDateAndUserNameAppendix(userProfile.userName)
  }

  return message
})

// ===== Per-conversation 系统提示词 =====

/** 每个对话选中的提示词 ID（分屏时独立） */
export const conversationPromptIdAtom = atom<Map<string, string>>(new Map())

/** 根据 promptId 解析 systemMessage（纯函数，不依赖全局 atom） */
export function resolveSystemMessage(
  promptId: string,
  config: SystemPromptConfig,
  userName: string,
): string | undefined {
  const prompt = config.prompts.find((p) => p.id === promptId)
  if (!prompt) return undefined

  let message = prompt.content

  if (config.appendDateTimeAndUserName) {
    message += buildDateAndUserNameAppendix(userName)
  }

  return message
}
