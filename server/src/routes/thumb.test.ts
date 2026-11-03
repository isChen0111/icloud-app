/**
 * 缩略图库作用域校验（libMismatch）
 *
 * 背景：资产 id 是**库内自增**，`/api/thumb/:id` 只按 id 查当前库。前端在 URL 上带
 * `lib=<库id>` 让浏览器按库分桶缓存，后端据此拒绝「不属于当前库」的请求。
 *
 * 这里只钉判定本身（纯函数，不碰 DB）：
 *  - 缺省必须放行（前端拿到第一份 /api/stats 之前不知道库 id，那段窗口要能出图）
 *  - 非法值必须拒绝（`Number('')` 是 0、`Number('1.5')` 非整数，都不能当成合法库）
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { libMismatch } from './thumb.js'

test('lib 缺省 → 不校验（退回旧的共享缓存行为）', () => {
  assert.equal(libMismatch(undefined, 18), false)
  assert.equal(libMismatch(undefined, null), false)
})

test('lib 与当前激活库一致 → 放行', () => {
  assert.equal(libMismatch('18', 18), false)
  assert.equal(libMismatch('19', 19), false)
})

test('lib 与当前激活库不一致 → 拒绝（切库瞬间的旧请求必须打回）', () => {
  assert.equal(libMismatch('18', 19), true)
  // 当前无激活库时，任何带 lib 的请求都找不到归属
  assert.equal(libMismatch('18', null), true)
})

test('lib 不是整数 → 拒绝（空串 / 小数 / 非数字都不能当成库 id）', () => {
  assert.equal(libMismatch('', 18), true, "Number('') === 0，不能误判为库 0")
  assert.equal(libMismatch('1.5', 18), true)
  assert.equal(libMismatch('abc', 18), true)
  assert.equal(libMismatch('18abc', 18), true, 'Number("18abc") 是 NaN，不能放行')
})
