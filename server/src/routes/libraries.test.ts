/**
 * 切库/删除守卫单元测试（审查 P1：在途扫描时拒绝切库/删除，防旧扫描经 getDb()
 * 动态代理写入新库、删除对账删空新库资产）。
 *
 * libraryBusyGuard 是纯守卫函数（routes/libraries.ts 抽出），
 * 其状态来源 syncState（icloudpd/state.ts 单例）与 scanProgress（scanner/index.ts）
 * 均为模块级导出对象，测试直接改写状态验证 409 文案与放行分支。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { libraryBusyGuard } from './libraries.js'
import { syncState, resetSyncState } from '../icloudpd/state.js'
import { scanProgress } from '../scanner/index.js'

function resetBusyState(): void {
  resetSyncState()
  scanProgress.status = 'idle'
  scanProgress.message = ''
}

test('libraryBusyGuard：空闲（无同步、无扫描）→ 切库/删除均放行', () => {
  resetBusyState()
  assert.equal(libraryBusyGuard('switch'), null)
  assert.equal(libraryBusyGuard('delete'), null)
})

test('libraryBusyGuard：同步任务执行中 → 切库/删除 409 文案', () => {
  resetBusyState()
  syncState.status = 'running'
  assert.match(libraryBusyGuard('switch')!, /同步任务执行中.*切换照片库/)
  assert.match(libraryBusyGuard('delete')!, /同步任务执行中.*删除照片库/)

  resetBusyState()
  syncState.status = 'waiting_retry'
  assert.match(libraryBusyGuard('switch')!, /同步任务执行中/)
})

test('libraryBusyGuard：在途扫描（P1）→ 切库/删除 409 文案', () => {
  resetBusyState()
  scanProgress.status = 'scanning'
  assert.equal(libraryBusyGuard('switch'), '照片库扫描进行中，请稍候再切换')
  assert.equal(libraryBusyGuard('delete'), '照片库扫描进行中，请稍候再删除')
})

test('libraryBusyGuard：同步与扫描同时忙 → 同步守卫优先（先报同步）', () => {
  resetBusyState()
  syncState.status = 'running'
  scanProgress.status = 'scanning'
  assert.match(libraryBusyGuard('switch')!, /同步任务执行中/)
  assert.match(libraryBusyGuard('delete')!, /同步任务执行中/)
})

test('libraryBusyGuard：扫描结束（error/done 态）→ 放行', () => {
  resetBusyState()
  scanProgress.status = 'error'
  assert.equal(libraryBusyGuard('switch'), null)
  scanProgress.status = 'done'
  assert.equal(libraryBusyGuard('delete'), null)
})
