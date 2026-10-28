/**
 * 视频 Range 解析测试（R-28）
 *
 * 重点是多段 Range：Safari 播放视频时会发 `bytes=0-1,100-200` 这类分段请求，
 * RFC 7233 允许服务端只满足其中一段；旧实现对整串做全锚定匹配必然失败，
 * 调用方据此返回 416，表现为 Safari 里视频完全播不了。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseRange } from './video.js'

const TOTAL = 10000

test('单段 Range：起止、开放结尾、末尾后缀三种形态', () => {
  assert.deepEqual(parseRange('bytes=0-99', TOTAL), { start: 0, end: 99 })
  assert.deepEqual(parseRange('bytes=100-', TOTAL), { start: 100, end: TOTAL - 1 })
  assert.deepEqual(parseRange('bytes=-500', TOTAL), { start: TOTAL - 500, end: TOTAL - 1 })
})

test('多段 Range 只满足首段，不再直接 416（R-28）', () => {
  assert.deepEqual(parseRange('bytes=0-1,100-200', TOTAL), { start: 0, end: 1 })
  // 逗号后有空格（部分客户端会这么发）
  assert.deepEqual(parseRange('bytes=0-1, 100-200', TOTAL), { start: 0, end: 1 })
  // 首段是开放结尾
  assert.deepEqual(parseRange('bytes=500-,900-999', TOTAL), { start: 500, end: TOTAL - 1 })
})

test('越界与非法头返回 null（调用方回退整文件或 416）', () => {
  assert.equal(parseRange(undefined, TOTAL), null)
  assert.equal(parseRange('', TOTAL), null)
  assert.equal(parseRange('items=0-1', TOTAL), null)
  assert.equal(parseRange('bytes=999999-', TOTAL), null) // 起点越界
  assert.equal(parseRange('bytes=200-100', TOTAL), null) // end < start
  assert.equal(parseRange('bytes=-0', TOTAL), null) // 空后缀
})

test('end 超出文件长度时钳到文件末尾', () => {
  assert.deepEqual(parseRange('bytes=9000-99999', TOTAL), { start: 9000, end: TOTAL - 1 })
})
