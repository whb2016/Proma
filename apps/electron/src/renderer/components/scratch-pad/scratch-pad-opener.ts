/**
 * Scratch Pad 侧边分屏入口。
 *
 * 与 Preview tear-off 保持同一交互：回到最近的 Agent 会话，
 * 并把草稿固定到右侧分屏。
 */

import type { useStore } from 'jotai'
import {
  activeTabIdAtom,
  getFixedTabs,
  isFixedTabId,
  scratchPadPanelOpenAtom,
  SCRATCH_PAD_ID,
  tabsAtom,
  type TabItem,
} from '@/atoms/tab-atoms'
import {
  agentSessionsAtom,
  currentAgentSessionIdAtom,
  currentAgentWorkspaceIdAtom,
} from '@/atoms/agent-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import { currentConversationIdAtom } from '@/atoms/chat-atoms'

interface ScratchPadAgentSession {
  id: string
  title: string
  archived?: boolean
  workspaceId?: string
}

type JotaiStore = ReturnType<typeof useStore>

function findTargetAgentTab(
  tabs: TabItem[],
  sessions: ScratchPadAgentSession[],
  currentSessionId: string | null,
): TabItem | null {
  const existingAgentTab = [...tabs].reverse().find((tab) => tab.type === 'agent')
  if (existingAgentTab) return existingAgentTab
  if (!currentSessionId) return null

  const session = sessions?.find((item) => item.id === currentSessionId && !item.archived)
  if (!session) return null
  return {
    id: session.id,
    type: 'agent',
    sessionId: session.id,
    title: session.title || 'Agent 会话',
  }
}

export function openScratchInSplit(store: JotaiStore): boolean {
  const tabs = store.get(tabsAtom)
  const scratchTab = tabs.find((tab) => tab.id === SCRATCH_PAD_ID && tab.type === 'scratch')
  if (!scratchTab) return false

  const sessions = store.get(agentSessionsAtom)
  const currentSessionId = store.get(currentAgentSessionIdAtom)
  const agentTab = findTargetAgentTab(tabs, sessions, currentSessionId)
  if (!agentTab) return false

  const baseTabs = tabs.filter((tab) => tab.id !== SCRATCH_PAD_ID)
  const hasAgentTab = baseTabs.some((tab) => tab.id === agentTab.id)
  const nextTabs = hasAgentTab ? baseTabs : [...baseTabs, agentTab]
  store.set(tabsAtom, nextTabs)
  store.set(activeTabIdAtom, agentTab.id)
  store.set(appModeAtom, 'agent')
  store.set(currentConversationIdAtom, null)
  store.set(currentAgentSessionIdAtom, agentTab.sessionId)

  const session = sessions.find((item) => item.id === agentTab.sessionId)
  if (session?.workspaceId) {
    store.set(currentAgentWorkspaceIdAtom, session.workspaceId)
    window.electronAPI.updateSettings({
      agentWorkspaceId: session.workspaceId,
    }).catch(console.error)
  }

  store.set(scratchPadPanelOpenAtom, true)
  return true
}

export function tearOffScratchToSplit(store: JotaiStore): void {
  openScratchInSplit(store)
}

export function closeScratchInSplit(store: JotaiStore): void {
  const tabs = store.get(tabsAtom)
  store.set(scratchPadPanelOpenAtom, false)

  if (tabs.some((tab) => tab.id === SCRATCH_PAD_ID)) return
  // 通过固定前缀重建，草稿会落在翻译入口右侧，而不是被插到最左。
  store.set(tabsAtom, [...getFixedTabs(tabs), ...tabs.filter((tab) => !isFixedTabId(tab.id))])
}
