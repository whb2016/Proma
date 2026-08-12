/**
 * Agent 出站附件的授权目录解析
 *
 * 「哪些目录里的文件可以发出去」= Agent 自身被授权访问的目录集合。QQ / 微信 Bridge
 * 的 send_attachment 工具与定时任务的同款工具都要这一步，抽在这里避免三份拷贝 ——
 * 这是安全边界，只应有一处实现。
 *
 * 单独成文件而不是并入 `bridge-outbound-attachment.ts`：那个文件刻意只依赖 node，
 * 好脱离 electron 直接单测（纯路径判断都在那边，已有测试覆盖），而这里要 import
 * agent-orchestrator。
 */

import type { ResolveOutboundPathResult } from './bridge-outbound-attachment'
import { resolveOutboundAttachmentPath } from './bridge-outbound-attachment'
import { collectAttachedDirectories } from './agent-orchestrator'
import { getAgentSessionMeta } from './agent-session-manager'
import { getAgentWorkspace } from './agent-workspace-manager'

/**
 * 解析并校验 Agent 要外发的附件路径
 *
 * 授权目录取 `collectAttachedDirectories`：会话工作台（Agent 的 cwd，产物通常就在
 * 那里）、会话/工作区附加目录、项目文件根。用单根会漏掉工作台，逼模型先复制一份，
 * 而上游提示词明确要求"不要先复制到当前工作目录"。
 */
export function resolveAgentOutboundAttachment(options: {
  sessionId: string
  workspaceId: string
  path: string
  maxSize: number
}): ResolveOutboundPathResult {
  const workspace = getAgentWorkspace(options.workspaceId)
  if (!workspace) return { ok: false, reason: '工作区不存在' }

  const roots = collectAttachedDirectories({
    sessionMeta: getAgentSessionMeta(options.sessionId),
    workspaceSlug: workspace.slug,
  })

  return resolveOutboundAttachmentPath(roots, options.path, options.maxSize)
}
