/**
 * QQ 机器人集成 Jotai 状态（多 Bot）
 *
 * 管理多个 QQ Bot 的 Bridge 连接状态，形态与钉钉一致。
 */

import { atom } from 'jotai'
import type { QQBotBridgeState, QQBridgeState } from '@proma/shared'

/** 所有 Bot 的状态（botId → 状态） */
export const qqBotStatesAtom = atom<Record<string, QQBotBridgeState>>({})

/** 任一 Bot 已连接 */
export const qqAnyConnectedAtom = atom((get) => {
  const states = get(qqBotStatesAtom)
  return Object.values(states).some((s) => s.status === 'connected')
})

/** 聚合状态：优先展示已连接，其次连接中，再次错误 */
export const qqBridgeStateAtom = atom<QQBridgeState>((get) => {
  const states = Object.values(get(qqBotStatesAtom))
  if (states.length === 0) return { status: 'disconnected' }
  return (
    states.find((s) => s.status === 'connected')
    ?? states.find((s) => s.status === 'connecting')
    ?? states.find((s) => s.status === 'error')
    ?? { status: 'disconnected' }
  )
})
