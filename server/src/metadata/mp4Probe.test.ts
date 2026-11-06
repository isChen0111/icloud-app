/**
 * #5 L1 自洽校验（validateProbe）的单元测试。
 *
 * 只测纯函数，不 spawn ffprobe。parser 本身（probeMp4）的正确性由一次性全量对照脚本
 * 对库内全部视频与 ffprobe 逐项核对（脚本不入库），这里守住「越界如何处置」的边界。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { validateProbe, type Mp4Probe } from './mp4Probe.js'

const UUID = '02DCEE37-674E-45DB-8827-6F9247450230'

function base(): Mp4Probe {
  return {
    contentIdentifier: UUID,
    duration: 3.5,
    width: 1920,
    height: 1080,
    creationTime: '2024-09-13T00:40:28.000Z',
    rotation: 0,
  }
}

test('validateProbe：合法结果原样通过', () => {
  const vm = validateProbe(base())
  assert.ok(vm)
  assert.equal(vm.contentIdentifier, UUID)
  assert.equal(vm.duration, 3.5)
  assert.equal(vm.width, 1920)
  assert.equal(vm.height, 1080)
  assert.equal(vm.creationTime, '2024-09-13T00:40:28.000Z')
})

test('validateProbe：UUID 非 null 但形态错 → 整文件判失败（null）', () => {
  assert.equal(validateProbe({ ...base(), contentIdentifier: 'not-a-uuid' }), null)
  // 段数不足
  assert.equal(validateProbe({ ...base(), contentIdentifier: '12345678-1234-1234-1234' }), null)
  // 含非十六进制字符
  assert.equal(validateProbe({ ...base(), contentIdentifier: '02DCEE37-674E-45DB-8827-6F9247450Z30' }), null)
  // 小写也合法，不应误判
  assert.equal(validateProbe({ ...base(), contentIdentifier: UUID.toLowerCase() })?.contentIdentifier, UUID.toLowerCase())
})

test('validateProbe：UUID 为 null 是合法结果（独立视频无实况标识）', () => {
  const vm = validateProbe({ ...base(), contentIdentifier: null })
  assert.ok(vm)
  assert.equal(vm.contentIdentifier, null)
})

test('validateProbe：宽高越界置 null，不整文件判失败', () => {
  assert.equal(validateProbe({ ...base(), width: 0 })!.width, null)
  assert.equal(validateProbe({ ...base(), width: -1 })!.width, null)
  assert.equal(validateProbe({ ...base(), width: 100000 })!.width, null)
  assert.equal(validateProbe({ ...base(), height: 0 })!.height, null)
  // 合法值不丢
  assert.equal(validateProbe({ ...base(), width: 1 })!.width, 1)
  assert.equal(validateProbe({ ...base(), height: 99999 })!.height, 99999)
})

test('validateProbe：时长越界置 null', () => {
  assert.equal(validateProbe({ ...base(), duration: -1 })!.duration, null)
  assert.equal(validateProbe({ ...base(), duration: 24 * 3600 + 0.001 })!.duration, null)
  // 边界 0 是合法值
  assert.equal(validateProbe({ ...base(), duration: 0 })!.duration, 0)
})

test('validateProbe：拍摄时间年份越界或缺失置 null', () => {
  assert.equal(validateProbe({ ...base(), creationTime: '1980-01-01T00:00:00.000Z' })!.creationTime, null)
  assert.equal(validateProbe({ ...base(), creationTime: null })!.creationTime, null)
  // 合法年份保留
  assert.equal(validateProbe({ ...base(), creationTime: '2024-09-13T00:40:28.000Z' })!.creationTime, '2024-09-13T00:40:28.000Z')
})
