import { describe, expect, test } from 'bun:test'
import { WECHAT_ITEM_TYPE, WECHAT_MEDIA_TYPE } from '@proma/shared'
import {
  decryptAesEcbWithKey,
  encodeAesKeyBase64,
  encodeAesKeyHex,
  encryptAesEcb,
  expectedCiphertextLength,
  generateAesKey,
  parseAesKey,
} from './wechat-media-crypto'

describe('AES-128-ECB 加解密', () => {
  test('加密后能原样解回（与下载路径互为镜像）', () => {
    const key = generateAesKey()
    const raw = Buffer.from('微信 iLink 媒体内容 with ascii', 'utf8')

    const decrypted = decryptAesEcbWithKey(encryptAesEcb(raw, key), key)

    expect(decrypted.equals(raw)).toBe(true)
  })

  test('密文长度符合协议公式 ceil((raw+1)/16)*16，含 16 字节对齐时也补整块', () => {
    const key = generateAesKey()
    // 15/16/17 覆盖「不足一块 / 正好一块 / 跨块」三种边界
    for (const size of [1, 15, 16, 17, 31, 32, 1000]) {
      const ciphertext = encryptAesEcb(Buffer.alloc(size, 0x61), key)
      expect(ciphertext.length).toBe(expectedCiphertextLength(size))
      // 对齐输入也必须多出一整块，否则 filesize 会少填 16 字节
      if (size % 16 === 0) expect(ciphertext.length).toBe(size + 16)
    }
  })

  test('非法密文长度被拒绝', () => {
    const key = generateAesKey()
    expect(() => decryptAesEcbWithKey(Buffer.alloc(0), key)).toThrow('长度非法')
    expect(() => decryptAesEcbWithKey(Buffer.alloc(17), key)).toThrow('长度非法')
  })
})

describe('aes_key 的两种编码', () => {
  const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')

  test('getuploadurl 用裸 hex（32 字符）', () => {
    expect(encodeAesKeyHex(key)).toBe('00112233445566778899aabbccddeeff')
    expect(encodeAesKeyHex(key)).toHaveLength(32)
  })

  test('sendmessage 的 media.aes_key 用 base64(hex 字符串)，不是 base64(原始 16 字节)', () => {
    const encoded = encodeAesKeyBase64(key)

    expect(encoded).toBe(Buffer.from('00112233445566778899aabbccddeeff', 'utf8').toString('base64'))
    // 与 base64(raw) 必须不同 —— 混用会让对方解不出内容
    expect(encoded).not.toBe(key.toString('base64'))
  })

  test('两种编码都能被入站 parseAesKey 解回同一个 key', () => {
    expect(parseAesKey(encodeAesKeyBase64(key)).equals(key)).toBe(true)
    expect(parseAesKey(encodeAesKeyHex(key)).equals(key)).toBe(true)
    // 入站图片场景的 base64(raw 16B)
    expect(parseAesKey(key.toString('base64')).equals(key)).toBe(true)
  })

  test('无法识别的 aes_key 抛错而非静默返回错误 key', () => {
    expect(() => parseAesKey('bm90LWEta2V5')).toThrow('aes_key 解析失败')
  })
})

describe('协议枚举', () => {
  test('上传的 media_type 与消息 item 的 type 是两套取值，不能互相复用', () => {
    // 上传：图片 1 / 文件 3；消息 item：图片 2 / 文件 4
    expect(WECHAT_MEDIA_TYPE.IMAGE).toBe(1)
    expect(WECHAT_MEDIA_TYPE.FILE).toBe(3)
    expect(WECHAT_ITEM_TYPE.IMAGE).toBe(2)
    expect(WECHAT_ITEM_TYPE.FILE).toBe(4)

    // 一旦哪天有人图省事把两者对齐，这里会立刻失败
    expect(WECHAT_MEDIA_TYPE.IMAGE).not.toBe(WECHAT_ITEM_TYPE.IMAGE)
    expect(WECHAT_MEDIA_TYPE.FILE).not.toBe(WECHAT_ITEM_TYPE.FILE)
  })
})
