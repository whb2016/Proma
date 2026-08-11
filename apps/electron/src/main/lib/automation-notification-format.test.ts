import { describe, expect, test } from 'bun:test'
import type { Automation, AutomationNotificationTarget, AutomationRun } from '@proma/shared'
import {
  buildAutomationLocalNotification,
  buildAutomationTextNotification,
  formatFeishuChatLabel,
  formatPushTargetGroupLabel,
  formatQQChatLabel,
  formatWeChatChatLabel,
  shouldNotifyAutomationTarget,
} from './automation-notification-format'
import { QQ_TEXT_CHUNK_SIZE, truncateForSingleMessage } from './qq-target'

function target(patch: Partial<AutomationNotificationTarget> = {}): AutomationNotificationTarget {
  return {
    type: 'wechat',
    enabled: true,
    trigger: 'always',
    botId: 'default',
    chatId: 'chat-1',
    ...patch,
  }
}

function automation(patch: Partial<Automation> = {}): Automation {
  return {
    id: 'a1',
    name: '每日 PR 汇总',
    prompt: 'p',
    active: true,
    scheduleType: 'daily',
    intervalMinutes: 10,
    channelId: 'c1',
    createdAt: 0,
    updatedAt: 0,
    nextRunAt: 0,
    runHistory: [],
    ...patch,
  }
}

function run(patch: Partial<AutomationRun> = {}): AutomationRun {
  return { runAt: 0, sessionId: 's1', status: 'success', durationMs: 90_000, ...patch }
}

describe('shouldNotifyAutomationTarget', () => {
  test('Given trigger=always When 成功或失败 Then 都通知', () => {
    expect(shouldNotifyAutomationTarget(target(), 'success')).toBe(true)
    expect(shouldNotifyAutomationTarget(target(), 'error')).toBe(true)
  })

  test('Given trigger=success When 失败 Then 不通知', () => {
    expect(shouldNotifyAutomationTarget(target({ trigger: 'success' }), 'error')).toBe(false)
    expect(shouldNotifyAutomationTarget(target({ trigger: 'success' }), 'success')).toBe(true)
  })

  test('Given trigger=error When 成功 Then 不通知', () => {
    expect(shouldNotifyAutomationTarget(target({ trigger: 'error' }), 'success')).toBe(false)
    expect(shouldNotifyAutomationTarget(target({ trigger: 'error' }), 'error')).toBe(true)
  })

  test('Given 任意 trigger When 运行被跳过 Then 不通知', () => {
    expect(shouldNotifyAutomationTarget(target(), 'skipped')).toBe(false)
    expect(shouldNotifyAutomationTarget(target({ trigger: 'error' }), 'skipped')).toBe(false)
  })

  test('Given enabled=false When 任何状态 Then 不通知', () => {
    expect(shouldNotifyAutomationTarget(target({ enabled: false }), 'success')).toBe(false)
  })

  test('Given 旧版飞书目标数据（无 label 字段） When 判断 Then 与新数据一致', () => {
    // 落盘的历史数据长这样，升级后不应因为缺 label 而失效
    const legacy = {
      type: 'feishu',
      enabled: true,
      trigger: 'always',
      botId: 'bot-1',
      chatId: 'oc_1',
    } as AutomationNotificationTarget
    expect(shouldNotifyAutomationTarget(legacy, 'success')).toBe(true)
  })
})

describe('buildAutomationTextNotification', () => {
  test('Given 成功运行 When 生成文本 Then 含任务名、耗时与摘要', () => {
    const text = buildAutomationTextNotification({
      automation: automation(),
      run: run(),
      summary: '合入 3 个 PR',
    })
    expect(text).toContain('✅ 定时任务已完成：每日 PR 汇总')
    expect(text).toContain('耗时 2 分钟')
    expect(text).toContain('合入 3 个 PR')
  })

  test('Given 失败运行 When 生成文本 Then 标记失败', () => {
    const text = buildAutomationTextNotification({
      automation: automation(),
      run: run({ status: 'error' }),
      summary: '拉取仓库失败',
    })
    expect(text).toContain('❌ 定时任务失败：每日 PR 汇总')
    expect(text).toContain('拉取仓库失败')
  })

  test('Given 成功但无输出 When 生成文本 Then 用兜底文案而不是留空', () => {
    const text = buildAutomationTextNotification({
      automation: automation(),
      run: run(),
      summary: '   ',
    })
    expect(text).toContain('Agent 已完成（无文本输出）')
  })

  test('Given 超长摘要 When 生成文本 Then 截断并提示回 Proma 看', () => {
    const text = buildAutomationTextNotification({
      automation: automation(),
      run: run(),
      summary: 'x'.repeat(5000),
    })
    expect(text.length).toBeLessThan(1300)
    expect(text).toContain('内容过长')
  })
})

describe('buildAutomationLocalNotification', () => {
  test('Given 多行摘要 When 生成系统通知 Then 正文取首个非空行', () => {
    const { title, body } = buildAutomationLocalNotification({
      automation: automation(),
      run: run(),
      summary: '\n\n  第一行结论  \n第二行细节',
    })
    expect(title).toBe('定时任务已完成')
    expect(body).toBe('每日 PR 汇总\n第一行结论')
  })

  test('Given 无摘要 When 生成系统通知 Then 正文退回耗时', () => {
    const { body } = buildAutomationLocalNotification({
      automation: automation(),
      run: run({ durationMs: 5_000 }),
      summary: '',
    })
    expect(body).toBe('每日 PR 汇总\n耗时 5.0 秒')
  })

  test('Given 失败运行 When 生成系统通知 Then 标题为失败', () => {
    const { title } = buildAutomationLocalNotification({
      automation: automation(),
      run: run({ status: 'error' }),
      summary: '出错了',
    })
    expect(title).toBe('定时任务失败')
  })
})

describe('推送目标标签', () => {
  test('Given 平台与 Bot 名 When 生成分组名 Then Bot 名跟在平台后', () => {
    expect(formatPushTargetGroupLabel('qq', '宵宫')).toBe('QQ 宵宫')
    expect(formatPushTargetGroupLabel('wechat')).toBe('微信')
    expect(formatPushTargetGroupLabel('feishu', '内部助手')).toBe('飞书 内部助手')
  })

  test('Given 飞书群绑定 When 生成聊天名 Then 用群名', () => {
    expect(formatFeishuChatLabel({ chatId: 'oc_123', chatType: 'group', groupName: '研发群' }))
      .toBe('研发群')
  })

  test('Given 飞书群无群名 When 生成聊天名 Then 退回短 id', () => {
    expect(formatFeishuChatLabel({ chatId: 'oc_1234567890', chatType: 'group' }))
      .toBe('群 (oc_12345…)')
  })

  test('Given 飞书单聊 When 生成聊天名 Then 标注单聊', () => {
    expect(formatFeishuChatLabel({ chatId: 'oc_1234567890', chatType: 'p2p' }))
      .toBe('单聊 (oc_12345…)')
  })

  test('Given 微信用户 When 生成聊天名 Then 只能显示短 id', () => {
    expect(formatWeChatChatLabel('wxid_abcdefghijk')).toBe('用户 (wxid_abc…)')
  })

  test('Given QQ chatId When 生成聊天名 Then 区分群与单聊', () => {
    expect(formatQQChatLabel('group:ABCDEF1234567')).toBe('群 (ABCDEF12…)')
    expect(formatQQChatLabel('c2c:ABCDEF1234567')).toBe('单聊 (ABCDEF12…)')
  })

  test('Given 短 id When 生成聊天名 Then 不加省略号', () => {
    expect(formatQQChatLabel('c2c:ABC')).toBe('单聊 (ABC)')
  })

  test('Given 格式异常的 chatId When 生成聊天名 Then 不抛错', () => {
    expect(formatQQChatLabel('bogus')).toBe('会话 (bogus)')
  })
})

describe('truncateForSingleMessage', () => {
  test('Given 未超长 When 截断 Then 原样返回', () => {
    expect(truncateForSingleMessage('短文本')).toBe('短文本')
  })

  test('Given 超长 When 截断 Then 不超过单条上限且带说明', () => {
    const out = truncateForSingleMessage('y'.repeat(QQ_TEXT_CHUNK_SIZE + 500))
    expect(out.length).toBe(QQ_TEXT_CHUNK_SIZE)
    expect(out).toContain('完整结果见 Proma')
  })
})
