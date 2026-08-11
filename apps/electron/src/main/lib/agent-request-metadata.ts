/**
 * Agent 请求的 metadata.user_id 构造
 *
 * Anthropic Messages API 支持 `metadata.user_id`，用于滥用追踪与限流；Pi 的
 * anthropic provider 会读取 `options.metadata.user_id` 并写入请求体
 * （其它 provider 不认这个字段，会直接忽略，因此无需按渠道做闸门）。
 *
 * 取值策略：`user_<用户名哈希>__session_<会话 id>`
 * - **必须哈希，不能直接放用户名**：官方建议该字段使用不透明标识符且不含 PII，
 *   而用户名属于身份信息，会经由上游与中间各层日志留痕；哈希后还顺带解决了
 *   用户名可能是中文（非 ASCII）带来的传输与日志编码不确定性。
 * - 同一用户名恒定映射到同一哈希，上游可按「用户」维度稳定聚合与限流。
 * - 用户名为空时用调用方给的兜底种子（当前是 userData 路径）：每台机器稳定、
 *   不含 PII，也不必为此新增一个设置项。
 */
import { createHash } from 'node:crypto'
import { getUserProfile } from './user-profile-service'

/** 哈希保留的十六进制位数：足以避免碰撞，又不至于让 user_id 过长 */
const HASH_LENGTH = 16

/** 用户名哈希的缓存有效期。避免每次模型请求都去读一次 user-profile.json。 */
const CACHE_TTL_MS = 60_000

let cached: { hash: string; at: number } | null = null

/**
 * 把用户名（或兜底种子）哈希成不透明的 ASCII 标识
 *
 * 加 `name:` / `seed:` 前缀区分来源，避免"用户名恰好等于兜底种子"时撞出同一个哈希。
 */
function hashIdentity(userName: string | undefined, fallbackSeed: string): string {
  const seed = userName?.trim() ? `name:${userName.trim()}` : `seed:${fallbackSeed}`
  return createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, HASH_LENGTH)
}

/**
 * 构造 user_id（纯函数，便于测试）
 *
 * @param userName 用户填写的用户名，可为中文；为空则使用 fallbackSeed
 * @param fallbackSeed 用户名为空时的兜底种子（需在同一台机器上稳定）
 * @param sessionId Agent 会话 id
 */
export function formatAgentUserId(
  userName: string | undefined,
  fallbackSeed: string,
  sessionId: string,
): string {
  return `user_${hashIdentity(userName, fallbackSeed)}__session_${sessionId}`
}

/**
 * 读取当前用户档案并构造 user_id
 *
 * @param fallbackSeed 用户名为空时的兜底种子
 * @param sessionId Agent 会话 id
 * @param now 注入当前时间，仅用于测试
 */
export function buildAgentUserId(fallbackSeed: string, sessionId: string, now = Date.now()): string {
  if (!cached || now - cached.at >= CACHE_TTL_MS) {
    let userName: string | undefined
    try {
      userName = getUserProfile().userName
    } catch (error) {
      // 读取失败不应阻断模型请求，退化为兜底种子
      console.warn('[Agent metadata] 读取用户档案失败，改用兜底种子:', error)
    }
    cached = { hash: hashIdentity(userName, fallbackSeed), at: now }
  }
  return `user_${cached.hash}__session_${sessionId}`
}

/** 清除缓存（用户名变更后可主动调用；测试也用它隔离用例） */
export function resetAgentUserIdCache(): void {
  cached = null
}
