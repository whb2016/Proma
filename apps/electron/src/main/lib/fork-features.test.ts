import { describe, expect, test } from 'bun:test'
import { getBuiltinMcpById, getBuiltinMcpDefinitions, RESERVED_BUILTIN_KEYS } from './builtin-mcp/baseline'
import { isRetiredDefaultSkill, RETIRED_DEFAULT_SKILL_SLUGS } from './config-paths'
import { DISABLED_BUILTIN_MCP_IDS, IN_APP_BROWSER_ENABLED } from './fork-features'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 本 fork 关闭了内置受管浏览器与内置 chrome-devtools MCP（理由见 fork-features.ts）。
 * 这些断言是合并上游时的绊线：上游若重构注册路径把它们又打开，这里会先失败，
 * 而不是等到用户发现工具表里多了 14 个 Browser* 才察觉。
 */
describe('fork 功能开关', () => {
  test('受管浏览器保持关闭', () => {
    expect(IN_APP_BROWSER_ENABLED).toBe(false)
  })

  test('内置 MCP 目录里不再出现 chrome-devtools', () => {
    expect(DISABLED_BUILTIN_MCP_IDS.has('chrome-devtools')).toBe(true)
    expect(getBuiltinMcpDefinitions().map((item) => item.id)).not.toContain('chrome-devtools')
    expect(getBuiltinMcpById('chrome-devtools')).toBeUndefined()
  })

  test('其余内置 MCP 不受影响', () => {
    const ids = getBuiltinMcpDefinitions().map((item) => item.id)
    expect(ids).toContain('automation')
    expect(ids).toContain('collaboration')
    expect(ids).toContain('nano-banana')
  })

  test('隐藏的内置 MCP 不再占用保留名', () => {
    // 保留名会让工作区 mcp.json 里的同名条目在保存时被剔除；
    // 既然目录里没有它了，用户就该能自己配一个同名 server。
    expect(RESERVED_BUILTIN_KEYS.has('chrome-devtools')).toBe(false)
    expect(RESERVED_BUILTIN_KEYS.has('chrome_devtools')).toBe(false)
    expect(RESERVED_BUILTIN_KEYS.has('automation')).toBe(true)
  })

  test('in-app-browser 默认 Skill 已退役', () => {
    // 退役即：bundled 目录被跳过，且老工作区里已装的 active/inactive 副本会被删掉。
    expect(RETIRED_DEFAULT_SKILL_SLUGS).toContain('in-app-browser')
    expect(isRetiredDefaultSkill('in-app-browser')).toBe(true)
    // 上游原有的退役项不能被覆盖掉
    expect(isRetiredDefaultSkill('brainstorming')).toBe(true)
    expect(isRetiredDefaultSkill('automation')).toBe(false)
  })

  test('退役 Skill 的 bundled 目录仍在，但必须被同步逻辑跳过', () => {
    // dev 实测过的坑：seedDefaultSkills 先删退役目录、再遍历 bundled 全量拷贝，
    // 少了这道跳过就会在同一次启动里"删掉又拷回来"。
    const bundledDir = join(__dirname, '../../../default-skills')
    if (!existsSync(bundledDir)) return

    const bundledSlugs = readdirSync(bundledDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)

    // 目录保留 = 与上游字节一致、合并不冲突
    expect(bundledSlugs).toContain('in-app-browser')
    // 但退役名单必须能拦住它
    expect(bundledSlugs.filter((slug) => !isRetiredDefaultSkill(slug))).not.toContain('in-app-browser')
  })
})
