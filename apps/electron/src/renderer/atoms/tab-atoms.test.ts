import { describe, expect, test } from 'bun:test'
import {
  closeTab,
  focusScratchPadTab,
  focusTranslateTab,
  getDefaultActiveTabId,
  getFixedTabs,
  getPersistableTabState,
  openTab,
  SCRATCH_PAD_ID,
  TRANSLATE_TAB_ID,
  type TabItem,
} from './tab-atoms'

function createAgentTab(id = 'agent-1'): TabItem {
  return {
    id,
    type: 'agent',
    sessionId: id,
    title: 'Agent 会话',
  }
}

describe('Scratch Pad Tab 恢复', () => {
  test('given 草稿已拖到右侧分屏 when Ctrl+Tab 聚焦草稿 then 恢复完整草稿并关闭分屏', () => {
    const result = focusScratchPadTab([
      createAgentTab(),
      {
        id: '__preview__:agent-1',
        type: 'preview',
        sessionId: 'agent-1',
        title: '预览：README.md',
      },
    ])

    expect(result.activeTabId).toBe(SCRATCH_PAD_ID)
    expect(result.scratchPanelOpen).toBe(false)
    expect(result.tabs.map((tab) => tab.id)).toEqual([
      TRANSLATE_TAB_ID,
      SCRATCH_PAD_ID,
      'agent-1',
      '__preview__:agent-1',
    ])
  })

  test('given 顶部已有固定草稿 when 再次聚焦 then 不重复创建草稿标签', () => {
    const existingScratch: TabItem = {
      id: SCRATCH_PAD_ID,
      type: 'scratch',
      sessionId: SCRATCH_PAD_ID,
      title: 'Scratch Pad',
    }

    const result = focusScratchPadTab([existingScratch, createAgentTab()])

    expect(result.tabs.filter((tab) => tab.id === SCRATCH_PAD_ID)).toEqual([existingScratch])
    expect(result.scratchPanelOpen).toBe(false)
  })
})

/**
 * 常驻入口（翻译 + 草稿）不是"push 一个进列表"就完事：openTab 每次重建整个数组，
 * 下面这些断言锁住"固定前缀"这条不变量 —— 上游改动 openTab 时会先在这里失败。
 */
describe('常驻入口固定前缀', () => {
  test('翻译在草稿左侧，且复用已存在的 Tab 对象', () => {
    const existingScratch: TabItem = {
      id: SCRATCH_PAD_ID,
      type: 'scratch',
      sessionId: SCRATCH_PAD_ID,
      title: 'Scratch Pad',
    }

    const fixed = getFixedTabs([createAgentTab(), existingScratch])

    expect(fixed.map((tab) => tab.id)).toEqual([TRANSLATE_TAB_ID, SCRATCH_PAD_ID])
    expect(fixed[0]!.type).toBe('translate')
    // 复用原对象引用，避免每次切 Tab 都让 TabBarItem 白重渲染
    expect(fixed[1]).toBe(existingScratch)
  })

  test('given 打开会话 when 重建列表 then 两个常驻入口仍在最左且顺序不变', () => {
    const result = openTab([], { type: 'agent', sessionId: 'agent-9', title: '新会话' })

    expect(result.tabs.map((tab) => tab.id)).toEqual([
      TRANSLATE_TAB_ID,
      SCRATCH_PAD_ID,
      'agent-9',
    ])
    expect(result.activeTabId).toBe('agent-9')
  })

  test('聚焦翻译入口保留会话上下文', () => {
    const result = focusTranslateTab([createAgentTab()])

    expect(result.activeTabId).toBe(TRANSLATE_TAB_ID)
    expect(result.tabs.map((tab) => tab.id)).toEqual([
      TRANSLATE_TAB_ID,
      SCRATCH_PAD_ID,
      'agent-1',
    ])
  })

  test('常驻入口关不掉，普通会话能关', () => {
    const tabs = openTab([], { type: 'agent', sessionId: 'agent-1', title: 'Agent 会话' }).tabs

    expect(closeTab(tabs, TRANSLATE_TAB_ID, TRANSLATE_TAB_ID).tabs).toBe(tabs)
    expect(closeTab(tabs, SCRATCH_PAD_ID, SCRATCH_PAD_ID).tabs).toBe(tabs)
    expect(closeTab(tabs, 'agent-1', 'agent-1').tabs.map((tab) => tab.id)).toEqual([
      TRANSLATE_TAB_ID,
      SCRATCH_PAD_ID,
    ])
  })

  test('常驻入口不写进持久化状态（每次启动重新注入）', () => {
    const tabs = openTab([], { type: 'chat', sessionId: 'chat-1', title: '新对话' }).tabs

    const persisted = getPersistableTabState(tabs, 'chat-1')

    expect(persisted.tabs.map((tab) => tab.id)).toEqual(['chat-1'])
    expect(persisted.activeTabId).toBe('chat-1')
  })

  test('无明确激活目标时默认落在草稿页，而不是最左的翻译页', () => {
    const tabs = getFixedTabs([])

    expect(tabs[0]!.id).toBe(TRANSLATE_TAB_ID)
    expect(getDefaultActiveTabId(tabs)).toBe(SCRATCH_PAD_ID)
  })
})
