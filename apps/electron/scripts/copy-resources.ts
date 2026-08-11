#!/usr/bin/env bun
/**
 * 把 resources/ 拷到 dist/resources/，供开发期与打包前的主进程读取。
 *
 * 背景：原实现是 package.json 里的 `cp -r resources dist/ 2>/dev/null || true`，
 * 有两个问题：
 * - Bun Shell 的内置 cp 不接受 `-r`（只认 `-R`），在 Windows 上直接失败；
 * - `2>/dev/null || true` 把错误完全吞掉，构建照常"成功"，但 dist/resources 不存在，
 *   表现为应用图标 / 托盘图标 / 原生启动页静默加载失败（ERR_FILE_NOT_FOUND），
 *   排查时很难联想到是资源拷贝这一步没做。
 *
 * 因此改用 node:fs 的 cpSync：不依赖 shell 内置命令在各平台的行为差异，
 * 且失败时以非零退出码中断构建，不再静默通过。
 *
 * 在 electron app 的 build 链中调用（见 package.json build:resources）。
 */
import { cpSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const electronDir = resolve(import.meta.dir, '..')
const srcDir = join(electronDir, 'resources')
const destDir = join(electronDir, 'dist', 'resources')

if (!existsSync(srcDir)) {
  console.error(`[资源拷贝] 源目录不存在，无法继续: ${srcDir}`)
  process.exit(1)
}

cpSync(srcDir, destDir, { recursive: true })
console.log(`[资源拷贝] resources -> ${destDir}`)
