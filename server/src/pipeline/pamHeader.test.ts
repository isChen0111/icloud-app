import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parsePamHeader } from './thumbnails.js'

/** 造一个 PAM buffer：头 + 每个像素填充固定值 */
function makePam(
  width: number,
  height: number,
  depth: number,
  opts: { eol?: string; payloadBytes?: number } = {},
): Buffer {
  const eol = opts.eol ?? '\n'
  const header = ['P7', `WIDTH ${width}`, `HEIGHT ${height}`, `DEPTH ${depth}`, 'MAXVAL 255', 'TUPLTYPE RGB', 'ENDHDR']
    .join(eol) + eol
  const payload = Buffer.alloc(opts.payloadBytes ?? width * height * depth, 7)
  return Buffer.concat([Buffer.from(header, 'latin1'), payload])
}

test('parsePamHeader 解析正常的 3 通道帧', () => {
  const buf = makePam(4, 3, 3)
  const frame = parsePamHeader(buf)
  assert.ok(frame)
  assert.equal(frame.width, 4)
  assert.equal(frame.height, 3)
  assert.equal(frame.channels, 3)
  assert.equal(frame.data.length, 4 * 3 * 3)
  assert.equal(frame.data[0], 7)
})

test('parsePamHeader 支持 CRLF 行尾', () => {
  const frame = parsePamHeader(makePam(2, 2, 3, { eol: '\r\n' }))
  assert.ok(frame)
  assert.equal(frame.width, 2)
  assert.equal(frame.height, 2)
  assert.equal(frame.data.length, 12)
})

test('parsePamHeader 接受 4 通道（RGBA）', () => {
  const frame = parsePamHeader(makePam(2, 2, 4))
  assert.ok(frame)
  assert.equal(frame.channels, 4)
  assert.equal(frame.data.length, 16)
})

test('parsePamHeader 对非 P7 数据返回 null', () => {
  assert.equal(parsePamHeader(Buffer.from('\x89PNG\r\n\x1a\n', 'latin1')), null)
  assert.equal(parsePamHeader(Buffer.alloc(0)), null)
})

test('parsePamHeader 缺 ENDHDR 返回 null', () => {
  const noEnd = Buffer.from('P7\nWIDTH 4\nHEIGHT 3\nDEPTH 3\nMAXVAL 255\n', 'latin1')
  assert.equal(parsePamHeader(noEnd), null)
})

test('parsePamHeader 像素区被截断返回 null', () => {
  // 头声明 4x3x3=36 字节负载，实际只给 10 字节
  assert.equal(parsePamHeader(makePam(4, 3, 3, { payloadBytes: 10 })), null)
})

test('parsePamHeader 拒绝非法 DEPTH（0 与 5）', () => {
  assert.equal(parsePamHeader(makePam(2, 2, 0)), null)
  assert.equal(parsePamHeader(makePam(2, 2, 5)), null)
})

test('parsePamHeader 忽略负载之后的多余字节', () => {
  // 多余尾随数据（例如管道尾块）应被裁掉，不喂给 sharp
  const frame = parsePamHeader(makePam(2, 2, 3, { payloadBytes: 12 + 8 }))
  assert.ok(frame)
  assert.equal(frame.data.length, 12)
})
