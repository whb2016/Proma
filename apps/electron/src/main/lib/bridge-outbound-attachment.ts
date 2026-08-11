/**
 * Bridge 出站附件的路径与大小校验
 *
 * 单独成模块是为了能不依赖 electron / 网络直接单测 —— 这几条校验是安全边界：
 * Agent 由模型驱动，工具参数里的路径不可信，必须限制在本会话工作区内，
 * 否则模型可以把任意本地文件（配置、密钥）发到聊天对方。
 */
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, normalize, resolve, sep } from 'node:path'

/** 校验结果 */
export type ResolveOutboundPathResult =
  | { ok: true; absolutePath: string; size: number }
  | { ok: false; reason: string }

/**
 * 判断 target 是否位于 root 之内
 *
 * Windows 上路径大小写不敏感，因此比较前统一小写；同时在末尾补分隔符，
 * 避免 `C:\work-secret` 被误判为在 `C:\work` 之内。
 */
export function isInsideRoot(root: string, target: string, caseInsensitive = process.platform === 'win32'): boolean {
  const norm = (p: string): string => {
    const n = normalize(p)
    return caseInsensitive ? n.toLowerCase() : n
  }
  const r = norm(root).replace(new RegExp(`\\${sep}+$`), '') + sep
  const t = norm(target)
  return t === r.slice(0, -1) || t.startsWith(r)
}

/**
 * 解析并校验 Agent 要发送的附件路径
 *
 * @param root 允许的根目录（本会话工作区的项目文件根）
 * @param inputPath 模型给的路径，可为相对（相对 root）或绝对
 * @param maxSize 大小上限（字节）
 */
export function resolveOutboundAttachmentPath(
  root: string,
  inputPath: string,
  maxSize: number,
): ResolveOutboundPathResult {
  const raw = inputPath?.trim()
  if (!raw) return { ok: false, reason: '路径为空' }

  // 绝对路径也要落在 root 内；相对路径按 root 解析
  const absolutePath = isAbsolute(raw) ? normalize(raw) : resolve(root, raw)

  if (!isInsideRoot(root, absolutePath)) {
    return { ok: false, reason: '路径超出当前工作区，已拒绝' }
  }
  if (!existsSync(absolutePath)) {
    return { ok: false, reason: '文件不存在' }
  }

  const stat = statSync(absolutePath)
  if (!stat.isFile()) {
    return { ok: false, reason: '目标不是文件' }
  }
  if (stat.size === 0) {
    return { ok: false, reason: '文件为空' }
  }
  if (stat.size > maxSize) {
    return { ok: false, reason: `文件 ${stat.size} 字节超过 ${Math.floor(maxSize / 1024 / 1024)}MB 限制` }
  }

  return { ok: true, absolutePath, size: stat.size }
}

/** 常见图片扩展名。用于决定按图片还是按文件发送。 */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

/** 按扩展名判断是否作为图片发送 */
export function isImageAttachment(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.')
  if (dot < 0) return false
  return IMAGE_EXTENSIONS.has(fileName.slice(dot).toLowerCase())
}
