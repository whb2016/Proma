import { describe, expect, test } from 'bun:test'
import { getAutomationOccurrencesByDay } from './automation-schedule'

/** 2026-08-12 周三 22:30，作为 nextRunAt 锚点 */
const WED_2230 = new Date(2026, 7, 12, 22, 30, 0, 0).getTime()

function dayLabels(
  automation: Parameters<typeof getAutomationOccurrencesByDay>[0],
  rangeStart: number,
  rangeEnd: number,
): string[] {
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const pad = (n: number): string => String(n).padStart(2, '0')
  return getAutomationOccurrencesByDay(automation, rangeStart, rangeEnd).map((bucket) => {
    const d = new Date(bucket.day)
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${names[d.getDay()]} ×${bucket.count}`
  })
}

describe('getAutomationOccurrencesByDay: daily + activeWeekdays', () => {
  const rangeStart = new Date(2026, 7, 12, 0, 0, 0, 0).getTime()
  const rangeEnd = new Date(2026, 7, 22, 23, 59, 59, 999).getTime()

  test('Given 工作日 22:30 When 展开两周 Then 日历里不出现周末', () => {
    expect(dayLabels(
      { scheduleType: 'daily', nextRunAt: WED_2230, timeOfDay: '22:30', activeWeekdays: [1, 2, 3, 4, 5] },
      rangeStart,
      rangeEnd,
    )).toEqual([
      '08-12 周三 ×1',
      '08-13 周四 ×1',
      '08-14 周五 ×1',
      '08-17 周一 ×1',
      '08-18 周二 ×1',
      '08-19 周三 ×1',
      '08-20 周四 ×1',
      '08-21 周五 ×1',
    ])
  })

  test('Given 不限星期 When 展开 Then 每天都有（与改动前一致）', () => {
    const labels = dayLabels(
      { scheduleType: 'daily', nextRunAt: WED_2230, timeOfDay: '22:30' },
      rangeStart,
      rangeEnd,
    )
    expect(labels).toHaveLength(11)
    expect(labels[3]).toBe('08-15 周六 ×1')
  })

  test('Given 周末 22:30 When 展开 Then 只有周六周日', () => {
    expect(dayLabels(
      { scheduleType: 'daily', nextRunAt: new Date(2026, 7, 15, 22, 30).getTime(), timeOfDay: '22:30', activeWeekdays: [0, 6] },
      rangeStart,
      rangeEnd,
    )).toEqual(['08-15 周六 ×1', '08-16 周日 ×1', '08-22 周六 ×1'])
  })

  test('Given maxRuns 未跑满 When 展开 Then 只给剩余次数', () => {
    expect(dayLabels(
      { scheduleType: 'daily', nextRunAt: WED_2230, timeOfDay: '22:30', activeWeekdays: [1, 2, 3, 4, 5], maxRuns: 2, runCount: 0 },
      rangeStart,
      rangeEnd,
    )).toEqual(['08-12 周三 ×1', '08-13 周四 ×1'])
  })
})
