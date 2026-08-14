/**
 * Pioneer fork 自有功能开关。
 *
 * 上游没有这类开关：内置受管浏览器的 14 个 `Browser*` 工具、对应的系统提示词小节，
 * 以及内置 chrome-devtools MCP 目录项都是无条件注入的。本 fork 只做文档处理、脚本
 * 开发、信息获取与定时任务，网页自动化改用外部 playwright-cli（真 Chrome、独立持久
 * profile、元素截图可直接落盘），所以把这两项关掉。
 *
 * 关的是「注册与提示词」，不是实现：`browser-controller.ts` 等约 2400 行原样保留，
 * 把开关翻回 true 即可恢复。这样上游怎么重构浏览器实现都不会与本 fork 冲突 ——
 * 冲突面被压到本文件加四处一行的引用。
 */

/**
 * 是否向 Agent 注入 Pi 受管浏览器。
 * 关闭后：14 个 `Browser*` 工具不进工具表（省约 2975 字符工具描述）、
 * `## Pi 受管浏览器` 提示词小节不生成、`<user_browser_context>` 不注入。
 * 浏览器面板 UI 仍在，用户可以手动浏览，只是 Agent 不再有对应工具。
 */
export const IN_APP_BROWSER_ENABLED = false

/**
 * 从内置 MCP 目录中隐藏的 id。
 * 隐藏后不出现在能力列表，也不再占用 `RESERVED_BUILTIN_KEYS` 保留名
 * （于是工作区 mcp.json 可以自己配同名 server）。
 */
export const DISABLED_BUILTIN_MCP_IDS: ReadonlySet<string> = new Set(['chrome-devtools'])
