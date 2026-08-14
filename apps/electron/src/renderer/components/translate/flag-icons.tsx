/**
 * 目标语言国旗图标（Pioneer fork 自有）
 *
 * 手写内联 SVG 而不是用 emoji：Windows 的 Segoe UI Emoji 不支持
 * regional indicator 组合，`🇨🇳` 会渲染成字母 "CN"。本 fork 只跑 Windows。
 *
 * 只求在 16px 见方下能一眼认出，不追求纹章级精确。
 */

import * as React from 'react'
import type { TranslationLanguageCode } from '@/types/translation'
import { cn } from '@/lib/utils'

const FLAG_CLASS = 'shrink-0 rounded-[2px] ring-1 ring-inset ring-black/10'

interface FlagProps {
  className?: string
}

/** 五角星（近似）：以中心点 + 半径生成 10 个顶点 */
function starPoints(cx: number, cy: number, outer: number, rotationDeg = -90): string {
  const inner = outer * 0.382
  const points: string[] = []
  for (let i = 0; i < 10; i++) {
    const radius = i % 2 === 0 ? outer : inner
    const angle = ((rotationDeg + i * 36) * Math.PI) / 180
    points.push(`${(cx + radius * Math.cos(angle)).toFixed(2)},${(cy + radius * Math.sin(angle)).toFixed(2)}`)
  }
  return points.join(' ')
}

/** 中国国旗：红底 + 一大四小五角星 */
export function FlagCN({ className }: FlagProps): React.ReactElement {
  return (
    <svg viewBox="0 0 24 16" className={cn(FLAG_CLASS, className)} aria-hidden="true">
      <rect width="24" height="16" fill="#de2910" />
      <g fill="#ffde00">
        <polygon points={starPoints(4.6, 4.4, 2.7)} />
        <polygon points={starPoints(9.2, 1.9, 0.9)} />
        <polygon points={starPoints(10.9, 3.9, 0.9)} />
        <polygon points={starPoints(10.9, 6.3, 0.9)} />
        <polygon points={starPoints(9.2, 8.1, 0.9)} />
      </g>
    </svg>
  )
}

/** 美国国旗：13 道条纹 + 蓝色 canton（星点简化为网格圆点） */
export function FlagUS({ className }: FlagProps): React.ReactElement {
  const stripeHeight = 16 / 13
  return (
    <svg viewBox="0 0 24 16" className={cn(FLAG_CLASS, className)} aria-hidden="true">
      <rect width="24" height="16" fill="#ffffff" />
      <g fill="#b22234">
        {[0, 2, 4, 6, 8, 10, 12].map((row) => (
          <rect key={row} y={row * stripeHeight} width="24" height={stripeHeight} />
        ))}
      </g>
      <rect width="10.2" height={stripeHeight * 7} fill="#3c3b6e" />
      <g fill="#ffffff">
        {[0, 1, 2, 3].map((row) =>
          [0, 1, 2, 3, 4].map((col) => (
            <circle
              key={`${row}-${col}`}
              cx={1.2 + col * 2}
              cy={1.1 + row * 2.1}
              r={0.42}
            />
          )),
        )}
      </g>
    </svg>
  )
}

/** 日本国旗：白底 + 正中红圆 */
export function FlagJP({ className }: FlagProps): React.ReactElement {
  return (
    <svg viewBox="0 0 24 16" className={cn(FLAG_CLASS, className)} aria-hidden="true">
      <rect width="24" height="16" fill="#ffffff" />
      <circle cx="12" cy="8" r="4.8" fill="#bc002d" />
    </svg>
  )
}

const FLAGS: Record<TranslationLanguageCode, (props: FlagProps) => React.ReactElement> = {
  zh: FlagCN,
  en: FlagUS,
  ja: FlagJP,
}

/** 按目标语言渲染国旗 */
export function LanguageFlag({
  code,
  className = 'h-3.5 w-[21px]',
}: {
  code: TranslationLanguageCode
  className?: string
}): React.ReactElement {
  const Flag = FLAGS[code] ?? FlagCN
  return <Flag className={className} />
}
