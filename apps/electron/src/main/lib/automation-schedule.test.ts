import { describe, expect, test } from 'bun:test'
import { computeNextRunAt } from './automation-manager'

/** 2026-08-12 是周三 */
const WED_10AM = new Date(2026, 7, 12, 10, 0, 0, 0).getTime()

function label(ts: number): string {
  const d = new Date(ts)
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${names[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 连续推 n 次，每次假设执行耗时 20 秒 */
function walk(cfg: Parameters<typeof computeNextRunAt>[0], from: number, n: number): string[] {
  const out: string[] = []
  let t = from
  for (let i = 0; i < n; i++) {
    const next = computeNextRunAt(cfg, t)
    out.push(label(next))
    t = next + 20_000
  }
  return out
}

describe('computeNextRunAt: daily + activeWeekdays', () => {
  test('Given 工作日 22:30 When 连续推进 Then 周末跳过、周五接周一', () => {
    const cfg = { scheduleType: 'daily' as const, timeOfDay: '22:30', activeWeekdays: [1, 2, 3, 4, 5] }
    expect(walk(cfg, WED_10AM, 6)).toEqual([
      '08-12 周三 22:30',
      '08-13 周四 22:30',
      '08-14 周五 22:30',
      '08-17 周一 22:30',
      '08-18 周二 22:30',
      '08-19 周三 22:30',
    ])
  })

  test('Given 周末 09:00 When 从周三推进 Then 直接跳到周六', () => {
    const cfg = { scheduleType: 'daily' as const, timeOfDay: '09:00', activeWeekdays: [0, 6] }
    expect(walk(cfg, WED_10AM, 3)).toEqual([
      '08-15 周六 09:00',
      '08-16 周日 09:00',
      '08-22 周六 09:00',
    ])
  })

  test('Given 当天时刻已过 When 计算 Then 落到下一个允许日的同一时刻', () => {
    // 周三 10:00 起算，只允许周三，时刻 09:00 已过 → 下周三
    const cfg = { scheduleType: 'daily' as const, timeOfDay: '09:00', activeWeekdays: [3] }
    expect(label(computeNextRunAt(cfg, WED_10AM))).toBe('08-19 周三 09:00')
  })

  test('Given activeWeekdays 缺省或空数组 When 计算 Then 与不限制星期一致', () => {
    const time = { scheduleType: 'daily' as const, timeOfDay: '22:30' }
    const expected = walk(time, WED_10AM, 4)
    expect(walk({ ...time, activeWeekdays: [] }, WED_10AM, 4)).toEqual(expected)
    expect(expected).toEqual(['08-12 周三 22:30', '08-13 周四 22:30', '08-14 周五 22:30', '08-15 周六 22:30'])
  })

  test('Given 非法星期值 When 计算 Then 被过滤掉而不是全盘拒绝', () => {
    // 7 与 -1 不是合法星期，过滤后只剩周一 → 不应变成「每天」
    const cfg = { scheduleType: 'daily' as const, timeOfDay: '08:00', activeWeekdays: [1, 7, -1] }
    expect(walk(cfg, WED_10AM, 2)).toEqual(['08-17 周一 08:00', '08-24 周一 08:00'])
  })
})

describe('computeNextRunAt: 其它模式不受运行日影响', () => {
  test('Given weekly 带 activeWeekdays When 计算 Then 只认 dayOfWeek', () => {
    // 归一化层会清掉 weekly 的 activeWeekdays；即便脏数据混进来也不能改变 weekly 的语义
    const cfg = { scheduleType: 'weekly' as const, timeOfDay: '10:00', dayOfWeek: 5, activeWeekdays: [1] }
    expect(label(computeNextRunAt(cfg, WED_10AM))).toBe('08-14 周五 10:00')
  })

  test('Given interval 带运行日 When 计算 Then 仍按窗口锚点走（回归）', () => {
    const cfg = {
      scheduleType: 'interval' as const,
      intervalMinutes: 1440,
      activeWindowStart: '22:30',
      activeWindowEnd: '22:31',
      activeWeekdays: [1, 2, 3, 4, 5],
    }
    expect(walk(cfg, WED_10AM, 4)).toEqual([
      '08-12 周三 22:30',
      '08-13 周四 22:30',
      '08-14 周五 22:30',
      '08-17 周一 22:30',
    ])
  })
})
