/**
 * iLink 媒体加解密与 aes_key 编码
 *
 * 从 wechat-bridge 抽出，一是为了能不起 electron 直接单测（这里的长度公式和两种
 * key 编码用错了会静默产出对方解不开的内容），二是上传与下载共用同一组原语。
 */
import * as crypto from 'node:crypto'

/** 生成上传用的 16 字节 AES key */
export function generateAesKey(): Buffer {
  return crypto.randomBytes(16)
}

/**
 * AES-128-ECB + PKCS7 加密（上传前对媒体字节加密）
 *
 * 密文长度必为 ceil((rawSize + 1) / 16) * 16 —— PKCS7 在长度已对齐时也会补一整块，
 * 协议文档给的就是这个公式，getuploadurl 的 filesize 必须填这个值。
 */
export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null)
  cipher.setAutoPadding(true)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

export function decryptAesEcbWithKey(ciphertext: Buffer, key: Buffer): Buffer {
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new Error(`AES-ECB 密文长度非法: ${ciphertext.length}`)
  }
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null)
  decipher.setAutoPadding(true)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/**
 * getuploadurl 的 aeskey 编码：**裸 hex 字符串**（32 字符）
 *
 * 与 encodeAesKeyBase64 是两种不同编码，用错位置服务端就解不出内容。
 */
export function encodeAesKeyHex(key: Buffer): string {
  return key.toString('hex')
}

/**
 * sendmessage 里 media.aes_key 的编码：**base64(hex 字符串)**
 *
 * 注意不是 base64(原始 16 字节)，这与 parseAesKey 支持的第二种入站格式对应。
 */
export function encodeAesKeyBase64(key: Buffer): string {
  return Buffer.from(key.toString('hex'), 'utf8').toString('base64')
}

/**
 * 解析 iLink aes_key 为 16 字节原始 AES key
 *
 * 参考官方 SDK：
 * - 图片场景：base64(raw 16 bytes)
 * - 文件/语音/视频：base64(32-char hex string)
 * - 备选：直接 32-char hex string（无 base64 外层）
 */
export function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex')
  }
  // 备选：输入本身就是 32-char hex（未经 base64 编码）
  if (aesKeyBase64.length === 32 && /^[0-9a-fA-F]{32}$/.test(aesKeyBase64)) {
    return Buffer.from(aesKeyBase64, 'hex')
  }
  throw new Error(`aes_key 解析失败：期望 16 字节或 32 字符 hex，实际 base64 解码后 ${decoded.length} 字节`)
}

/** 协议规定的密文长度公式，供上传前校验与测试使用 */
export function expectedCiphertextLength(rawSize: number): number {
  return Math.ceil((rawSize + 1) / 16) * 16
}
