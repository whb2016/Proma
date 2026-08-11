import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isImageAttachment, isInsideRoot, resolveOutboundAttachmentPath } from './bridge-outbound-attachment'

const MAX = 20 * 1024 * 1024

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'proma-outbound-'))
  writeFileSync(join(root, 'report.pdf'), 'x'.repeat(100))
  mkdirSync(join(root, 'sub'), { recursive: true })
  writeFileSync(join(root, 'sub', 'chart.png'), 'y'.repeat(50))
  writeFileSync(join(root, 'empty.txt'), '')
  return root
}

describe('isInsideRoot', () => {
  test('同名前缀的兄弟目录不算在内（避免 work-secret 被当成 work 的子目录）', () => {
    expect(isInsideRoot('/a/work', '/a/work/file.txt', false)).toBe(true)
    expect(isInsideRoot('/a/work', '/a/work-secret/file.txt', false)).toBe(false)
  })

  test('根目录自身算在内', () => {
    expect(isInsideRoot('/a/work', '/a/work', false)).toBe(true)
  })

  test('大小写不敏感模式（Windows）', () => {
    expect(isInsideRoot('C:\\Work', 'C:\\work\\a.txt', true)).toBe(true)
    expect(isInsideRoot('C:\\Work', 'C:\\work\\a.txt', false)).toBe(false)
  })
})

describe('resolveOutboundAttachmentPath', () => {
  test('工作区内的相对路径通过，并返回绝对路径与大小', () => {
    const root = makeRoot()
    try {
      const r = resolveOutboundAttachmentPath([root], 'report.pdf', MAX)
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.absolutePath).toBe(join(root, 'report.pdf'))
        expect(r.size).toBe(100)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('子目录路径通过', () => {
    const root = makeRoot()
    try {
      expect(resolveOutboundAttachmentPath([root], 'sub/chart.png', MAX).ok).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('用 .. 逃出工作区被拒绝', () => {
    const root = makeRoot()
    try {
      const r = resolveOutboundAttachmentPath([root], '../../etc/passwd', MAX)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain('超出当前会话的授权目录范围')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('工作区外的绝对路径被拒绝', () => {
    const root = makeRoot()
    const outside = mkdtempSync(join(tmpdir(), 'proma-outside-'))
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    try {
      const r = resolveOutboundAttachmentPath([root], join(outside, 'secret.txt'), MAX)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain('超出当前会话的授权目录范围')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('不存在 / 目录 / 空文件 / 超限 分别被拒绝', () => {
    const root = makeRoot()
    try {
      expect(resolveOutboundAttachmentPath([root], 'nope.txt', MAX)).toMatchObject({ ok: false, reason: '文件不存在' })
      expect(resolveOutboundAttachmentPath([root], 'sub', MAX)).toMatchObject({ ok: false, reason: '目标不是文件' })
      expect(resolveOutboundAttachmentPath([root], 'empty.txt', MAX)).toMatchObject({ ok: false, reason: '文件为空' })

      const tooSmallLimit = 10
      const r = resolveOutboundAttachmentPath([root], 'report.pdf', tooSmallLimit)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain('超过')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('空路径被拒绝', () => {
    expect(resolveOutboundAttachmentPath(['/root'], '   ', MAX)).toMatchObject({ ok: false, reason: '路径为空' })
  })

  test('没有授权目录时拒绝', () => {
    expect(resolveOutboundAttachmentPath([], 'a.txt', MAX)).toMatchObject({ ok: false, reason: '没有可用的授权目录' })
    expect(resolveOutboundAttachmentPath(['', '  '], 'a.txt', MAX)).toMatchObject({ ok: false, reason: '没有可用的授权目录' })
  })

  test('多个授权根：文件在会话工作台（非项目根）也能发，不必先复制', () => {
    // 复现实际踩到的场景：Agent 的 cwd 是会话工作台，附件在那里；
    // 若只放行项目根，模型就被迫先把文件复制进项目目录。
    const sessionRoot = makeRoot()
    const projectRoot = mkdtempSync(join(tmpdir(), 'proma-project-'))
    try {
      const roots = [sessionRoot, projectRoot]

      // 绝对路径
      const abs = resolveOutboundAttachmentPath(roots, join(sessionRoot, 'report.pdf'), MAX)
      expect(abs.ok).toBe(true)

      // 相对路径：按各根依次解析，命中会话工作台里的那个
      const rel = resolveOutboundAttachmentPath(roots, 'report.pdf', MAX)
      expect(rel.ok).toBe(true)
      if (rel.ok) expect(rel.absolutePath).toBe(join(sessionRoot, 'report.pdf'))
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true })
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('多个授权根：仍然拒绝所有根之外的路径', () => {
    const a = makeRoot()
    const b = mkdtempSync(join(tmpdir(), 'proma-b-'))
    const outside = mkdtempSync(join(tmpdir(), 'proma-outside-'))
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    try {
      const r = resolveOutboundAttachmentPath([a, b], join(outside, 'secret.txt'), MAX)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain('超出当前会话的授权目录范围')
    } finally {
      for (const d of [a, b, outside]) rmSync(d, { recursive: true, force: true })
    }
  })
})

describe('isImageAttachment', () => {
  test('常见图片扩展名识别为图片，大小写无关', () => {
    for (const name of ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.bmp']) {
      expect(isImageAttachment(name)).toBe(true)
    }
  })

  test('其余按文件处理', () => {
    for (const name of ['a.pdf', 'b.zip', 'c.md', 'noext', 'd.svg']) {
      expect(isImageAttachment(name)).toBe(false)
    }
  })
})
