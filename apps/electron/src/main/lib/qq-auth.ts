/**
 * QQ 开放平台 access token 管理
 *
 * `POST https://bots.qq.com/app/getAppAccessToken`（body: appId + clientSecret）
 * 返回 `{access_token, expires_in}`，有效期不超过 7200 秒。官方在旧 token 临近过期
 * 的 60 秒内换发时会让新旧并存，因此提前刷新是安全的。
 *
 * 这里在到期前留出缓冲提前换发：WebSocket 的 Identify/Resume 与 REST 调用都依赖它，
 * 等真过期再换会导致连接被断。
 */
import { redactSensitiveLogValue } from './bridge-log-redaction'

const ACCESS_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const REQUEST_TIMEOUT_MS = 10_000
/** 提前刷新的缓冲时间 */
const REFRESH_BUFFER_MS = 60_000
/** expires_in 异常小或缺失时的兜底有效期 */
const FALLBACK_TTL_MS = 300_000

interface AccessTokenResponse {
  access_token?: string
  expires_in?: number | string
  code?: number
  message?: string
}

/**
 * 取 access token，带进程内缓存
 *
 * 同一 Bot 的并发调用共享同一个在途请求，避免连接重建时打出多次换发。
 */
export class QQAuth {
  private cached: { token: string; expiresAt: number } | null = null
  private inflight: Promise<string> | null = null

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
  ) {}

  /** 取一个可用的 access token（必要时换发） */
  async getToken(now = Date.now()): Promise<string> {
    if (this.cached && this.cached.expiresAt - REFRESH_BUFFER_MS > now) {
      return this.cached.token
    }
    if (this.inflight) return this.inflight

    this.inflight = this.fetchToken(now).finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  /** Identify / Resume 与 REST 调用统一用这个格式 */
  async getAuthorizationHeader(): Promise<string> {
    return `QQBot ${await this.getToken()}`
  }

  /** 丢弃缓存，强制下次重新换发（收到 401 或 op9 时调用） */
  invalidate(): void {
    this.cached = null
  }

  private async fetchToken(now: number): Promise<string> {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS)
    try {
      const resp = await fetch(ACCESS_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret }),
        signal: ac.signal,
      })
      const text = await resp.text()
      if (!resp.ok) {
        throw new Error(`获取 access token 失败: HTTP ${resp.status} ${text.slice(0, 200)}`)
      }

      let data: AccessTokenResponse
      try {
        data = JSON.parse(text) as AccessTokenResponse
      } catch {
        throw new Error(`获取 access token 失败: 响应不是 JSON ${text.slice(0, 200)}`)
      }

      if (!data.access_token) {
        // 凭证错误时平台在 200 里带 code/message，不能只看 HTTP 状态
        const detail = data.message ? `${data.message}（code ${data.code}）` : text.slice(0, 200)
        throw new Error(`获取 access token 失败: ${detail}`)
      }

      const ttlSeconds = Number(data.expires_in)
      const ttlMs = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds * 1000 : FALLBACK_TTL_MS
      this.cached = { token: data.access_token, expiresAt: now + ttlMs }
      return data.access_token
    } catch (error) {
      console.error('[QQ 鉴权] 换发 access token 失败:', redactSensitiveLogValue(error))
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}
