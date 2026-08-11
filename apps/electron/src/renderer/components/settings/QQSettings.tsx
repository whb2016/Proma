/**
 * QQSettings - QQ 机器人集成设置页（多 Bot）
 *
 * 结构与钉钉设置页一致：Bot 列表 + 每个 Bot 的凭证表单 + 创建引导。
 * 额外多一个「沙箱环境」开关 —— QQ 机器人发布审核通过前只能走沙箱。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { toast } from 'sonner'
import { Loader2, ExternalLink, Power, PowerOff, Plus, Trash2, CheckCircle2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingsSection } from './primitives/SettingsSection'
import { SettingsCard } from './primitives/SettingsCard'
import { SettingsInput } from './primitives/SettingsInput'
import { SettingsSecretInput } from './primitives/SettingsSecretInput'
import { SettingsToggle } from './primitives/SettingsToggle'
import { qqBotStatesAtom } from '@/atoms/qq-atoms'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'
import type { QQBotConfig, QQBotBridgeState, QQBridgeStatus, QQTestResult } from '@proma/shared'

function openLink(url: string): void {
  window.electronAPI.openExternal(url)
}

function Link({ href, children }: { href: string; children: React.ReactNode }): React.ReactElement {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 text-primary hover:underline cursor-pointer"
      onClick={() => openLink(href)}
    >
      {children}
      <ExternalLink className="size-3 flex-shrink-0" />
    </button>
  )
}

const STATUS_CONFIG: Record<QQBridgeStatus, { color: string; label: string }> = {
  disconnected: { color: 'bg-gray-400', label: '未连接' },
  connecting: { color: 'bg-amber-400 animate-pulse', label: '连接中...' },
  connected: { color: 'bg-green-500', label: '已连接' },
  error: { color: 'bg-red-500', label: '连接错误' },
}

// ===== 主组件 =====

export function QQSettings(): React.ReactElement {
  const botStates = useAtomValue(qqBotStatesAtom)
  const [bots, setBots] = React.useState<QQBotConfig[]>([])
  const [loading, setLoading] = React.useState(true)

  const loadBots = React.useCallback(async () => {
    try {
      const config = await window.electronAPI.getQQMultiConfig()
      setBots(config.bots)
    } catch {
      toast.error('读取 QQ 配置失败')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { loadBots() }, [loadBots])

  const handleAddBot = React.useCallback(async () => {
    try {
      const saved = await window.electronAPI.saveQQBotConfig({
        name: `QQ 助手 ${bots.length + 1}`,
        enabled: false,
        appId: '',
        appSecret: '',
        // 默认沙箱：未发布的机器人只能走沙箱，避免用户一上手就连不上
        sandbox: true,
      })
      setBots((prev) => [...prev, saved])
    } catch {
      toast.error('创建 Bot 失败')
    }
  }, [bots.length])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={24} className="animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <SettingsSection
        title="QQ Bot 列表"
        description="管理多个 QQ 机器人，每个 Bot 可绑定不同的项目和模型"
        action={
          <Button size="sm" variant="outline" onClick={handleAddBot}>
            <Plus size={14} className="mr-1.5" />
            添加 Bot
          </Button>
        }
      >
        {bots.length === 0 ? (
          <SettingsCard divided={false}>
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              还没有配置 QQ Bot。点击「添加 Bot」开始。
            </div>
          </SettingsCard>
        ) : (
          <div className="space-y-3">
            {bots.map((bot) => (
              <BotConfigCard
                key={bot.id}
                bot={bot}
                state={botStates[bot.id]}
                onSaved={loadBots}
                onRemoved={loadBots}
              />
            ))}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title="创建 QQ 机器人"
        description="按以下步骤在 QQ 开放平台创建机器人并开通所需权限"
      >
        <SettingsCard divided={false}>
          <div className="px-4 py-4 space-y-5 text-sm">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">1</span>
                <span className="font-medium text-foreground">注册并创建机器人</span>
              </div>
              <p className="pl-7 text-muted-foreground">
                前往 <Link href="https://q.qq.com">QQ 开放平台</Link>
                ，完成主体入驻（个人或企业均可），创建一个机器人应用。
              </p>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">2</span>
                <span className="font-medium text-foreground">获取 AppID 与 AppSecret</span>
              </div>
              <p className="pl-7 text-muted-foreground">
                在应用的「开发设置」中找到{' '}
                <span className="text-foreground font-medium">AppID</span> 和{' '}
                <span className="text-foreground font-medium">AppSecret</span>，填到上方表单里。
              </p>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 text-xs font-semibold flex items-center justify-center">3</span>
                <span className="font-medium text-foreground">申请群聊与单聊事件权限（必须）</span>
              </div>
              <p className="pl-7 text-muted-foreground">
                在开放平台申请
                <span className="text-foreground font-medium">「群聊 @ 机器人」与「单聊消息」</span>
                的事件订阅权限。这两项<span className="text-foreground font-medium">不在默认可订阅范围内</span>；
                未开通时连接会在建立后立刻被服务端断开，表现为状态反复在「连接中」与「连接错误」之间跳。
              </p>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">4</span>
                <span className="font-medium text-foreground">先用沙箱联调</span>
              </div>
              <p className="pl-7 text-muted-foreground">
                发布审核通过前请保持「沙箱环境」开启，并在开放平台配置沙箱测试群与测试成员 ——
                沙箱机器人只接收沙箱环境内的消息。审核通过后关闭该开关即切到生产环境。
              </p>
            </div>

            <div className="pl-7 pt-1 text-xs text-muted-foreground">
              使用方式：群里 <span className="text-foreground">@ 机器人</span> 或直接单聊发消息；
              发送 <span className="text-foreground">/help</span> 查看可用命令。
              受平台限制，机器人只能被动回复，且单条消息可回复的条数有上限，过长的回复会被截断。
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}

// ===== 单个 Bot 配置卡片 =====

interface BotConfigCardProps {
  bot: QQBotConfig
  state: QQBotBridgeState | undefined
  onSaved: () => void
  onRemoved: () => void
}

function BotConfigCard({ bot, state, onSaved, onRemoved }: BotConfigCardProps): React.ReactElement {
  const [name, setName] = React.useState(bot.name)
  const [appId, setAppId] = React.useState(bot.appId)
  const [appSecret, setAppSecret] = React.useState('')
  const [sandbox, setSandbox] = React.useState(bot.sandbox)
  const [testing, setTesting] = React.useState(false)
  const [testResult, setTestResult] = React.useState<QQTestResult | null>(null)
  const [expanded, setExpanded] = React.useState(!bot.appId)

  // 回填已保存的 secret，便于用户查看与修改
  React.useEffect(() => {
    if (bot.appSecret && bot.id) {
      window.electronAPI.getDecryptedQQBotSecret(bot.id)
        .then((s: string) => { if (s) setAppSecret(s) })
        .catch(() => {})
    }
  }, [bot.id, bot.appSecret])

  const statusConfig = state ? STATUS_CONFIG[state.status] : STATUS_CONFIG.disconnected
  const isRunning = state?.status === 'connected' || state?.status === 'connecting'

  const handleSave = React.useCallback(async () => {
    if (!appId.trim() || !name.trim()) return
    try {
      await window.electronAPI.saveQQBotConfig({
        id: bot.id,
        name: name.trim(),
        enabled: true,
        appId: appId.trim(),
        appSecret: appSecret || '',
        sandbox,
      })
      toast.success(`Bot "${name}" 已保存`)
      onSaved()
    } catch {
      toast.error('保存配置失败')
    }
  }, [bot.id, name, appId, appSecret, sandbox, onSaved])

  const handleTest = React.useCallback(async () => {
    if (!appId.trim()) return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.electronAPI.testQQConnection({
        appId: appId.trim(),
        appSecret: appSecret.trim(),
        sandbox,
        botId: bot.id,
      })
      setTestResult(result)
    } catch (err) {
      setTestResult({ success: false, message: `测试失败: ${err instanceof Error ? err.message : String(err)}` })
    } finally {
      setTesting(false)
    }
  }, [appId, appSecret, sandbox, bot.id])

  const handleToggle = React.useCallback(async () => {
    if (isRunning) {
      await window.electronAPI.stopQQBot(bot.id)
      toast.success(`Bot "${bot.name}" 已停止`)
      return
    }
    try {
      await window.electronAPI.startQQBot(bot.id)
      toast.success(`Bot "${bot.name}" 启动中...`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '启动失败')
    }
  }, [bot.id, bot.name, isRunning])

  const handleRemove = React.useCallback(async () => {
    try {
      await window.electronAPI.removeQQBot(bot.id)
      toast.success(`Bot "${bot.name}" 已删除`)
      onRemoved()
    } catch {
      toast.error('删除失败')
    }
  }, [bot.id, bot.name, onRemoved])

  return (
    <SettingsCard>
      <button
        type="button"
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-3">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusConfig.color}`} />
          <span className="font-medium text-sm">{bot.name || '未命名 Bot'}</span>
          <span className="text-xs text-muted-foreground">
            {bot.appId ? bot.appId : '未配置'}
          </span>
          {bot.sandbox && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400">沙箱</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isRunning ? (
            <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); handleToggle() }}>
              <PowerOff size={14} className="mr-1" />
              停止
            </Button>
          ) : bot.appId ? (
            <Button
              size="sm"
              variant="outline"
              onClick={(e) => { e.stopPropagation(); handleToggle() }}
              disabled={state?.status === 'connecting'}
            >
              <Power size={14} className="mr-1" />
              启动
            </Button>
          ) : null}
          <span className="text-xs text-muted-foreground">{expanded ? '▾' : '▸'}</span>
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-4 border-t border-border pt-4">
          <SettingsInput
            label="Bot 名称"
            value={name}
            onChange={setName}
            placeholder="如：研发助手"
          />
          <SettingsInput
            label="AppID"
            value={appId}
            onChange={setAppId}
            placeholder="102xxxxxx"
          />
          <SettingsSecretInput
            label="AppSecret"
            value={appSecret}
            onChange={setAppSecret}
            placeholder="输入 AppSecret"
          />
          <SettingsToggle
            label="沙箱环境"
            description="发布审核通过前必须开启；沙箱机器人只接收沙箱测试群与测试成员的消息"
            checked={sandbox}
            onCheckedChange={setSandbox}
          />

          <div className="flex items-center gap-3">
            <Button size="sm" variant="outline" onClick={handleTest} disabled={testing || !appId.trim()}>
              {testing && <Loader2 size={14} className="animate-spin" />}
              <span>{testing ? '测试中...' : '测试连接'}</span>
            </Button>
            <Button size="sm" onClick={handleSave} disabled={!appId.trim() || !name.trim()}>
              保存配置
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="destructive">
                  <Trash2 size={14} className="mr-1" />
                  删除
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>确认删除</AlertDialogTitle>
                  <AlertDialogDescription>
                    删除 Bot &quot;{bot.name}&quot; 将同时断开连接。此操作不可撤销。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction onClick={handleRemove}>删除</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>

          {testResult && (
            <div className={cn(
              'p-3 rounded-lg flex items-start gap-2 text-sm',
              testResult.success ? 'bg-green-500/10 text-green-700 dark:text-green-400' : 'bg-red-500/10 text-red-700 dark:text-red-400',
            )}>
              {testResult.success
                ? <CheckCircle2 size={16} className="flex-shrink-0 mt-0.5" />
                : <XCircle size={16} className="flex-shrink-0 mt-0.5" />}
              <span>{testResult.message}</span>
            </div>
          )}

          {state?.status === 'error' && state.errorMessage && (
            <div className="p-2.5 rounded-lg bg-red-500/10 text-red-700 dark:text-red-400 text-sm">
              {state.errorMessage}
            </div>
          )}
        </div>
      )}
    </SettingsCard>
  )
}
