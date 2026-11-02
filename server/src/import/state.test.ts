/**
 * 导入任务状态机：运行令牌与「取消 ≠ 终态」（审查 C-01，2026-11-02）
 *
 * 旧实现的取消只是一次 `status = 'cancelled'` 赋值，于是取消信号和终态共用一个字段：
 *   ① 主循环的 `isCancelled()` 读的也是 status，新任务把它改回 `'running'` 后，
 *      旧主循环下一次检查即返回 false —— 取消等于没取消，两条流水线同时写同一目录；
 *   ② 旧主循环结束时无条件写终态，会把新任务的 done/finishedAt 冲掉；
 *   ③ 取消后 `isImportBusy()` 立刻变 false，切库/删库守卫全放行，而文件还在往里拷。
 *
 * 现在：`runToken` 决定「谁有资格写状态」，`cancelRequested` 只作信号不改 status，
 * `isImportBusy()` 覆盖「已请求取消、流水线尚未收尾」的过渡期。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  importState,
  resetImportState,
  beginImportRun,
  currentImportToken,
  isImportBusy,
  isImportCancelRequested,
  requestImportCancel,
} from './state.js'

/** 每个用例从干净状态起步 */
function fresh(): number {
  resetImportState()
  return beginImportRun()
}

test('C-01：isImportBusy 覆盖「已请求取消、流水线尚未收尾」的过渡期', () => {
  fresh()
  assert.equal(isImportBusy(), false, 'idle 时不算忙')

  importState.status = 'running'
  assert.equal(isImportBusy(), true)

  // 取消后（终态还没写）：文件仍在拷、watcher 仍关着，必须继续算忙
  importState.status = 'cancelled'
  importState.finishedAt = null
  assert.equal(isImportBusy(), true, '过渡期必须占住忙碌位，否则切库/再导入会撞车')

  // 流水线真正收尾后
  importState.finishedAt = new Date().toISOString()
  assert.equal(isImportBusy(), false, '收尾后应放行')

  importState.status = 'done'
  assert.equal(isImportBusy(), false)
})

test('C-01：取消只置信号，不直接改 status', () => {
  fresh()
  importState.status = 'running'
  importState.phase = 'copying'

  assert.equal(requestImportCancel(), true)
  // 关键：status 仍是 running。若这里被改成 cancelled，新任务 resetImportState +
  // status='running' 之后，旧主循环的取消检查就再也看不到了
  assert.equal(importState.status, 'running', '取消不得直接改 status（否则信号会被新任务抹掉）')
  assert.equal(importState.message, '正在取消…')
  assert.equal(isImportCancelRequested(), true)

  // 重复请求幂等
  assert.equal(requestImportCancel(), true)
  assert.equal(importState.status, 'running')

  // 没有任务在跑时不受理
  importState.status = 'done'
  importState.finishedAt = new Date().toISOString()
  assert.equal(requestImportCancel(), false)
})

test('C-06：落库阶段不受理取消（文件已归置完，中途退只会留下一半入库的照片）', () => {
  fresh()
  importState.status = 'running'
  importState.phase = 'scanning'

  assert.equal(requestImportCancel(), false, '扫描阶段取消会被受理成「已取消」，实际只是白等')
  assert.equal(isImportCancelRequested(), false)
  assert.equal(importState.message, '', '也不该把文案改成「正在取消…」')
  // 但仍然算忙：落库没结束前不能切库
  assert.equal(isImportBusy(), true)
})

test('C-01：新任务接管后令牌变化，旧运行随之失去写状态资格', () => {
  const token1 = fresh()
  importState.status = 'running'
  requestImportCancel()

  const token2 = beginImportRun()
  assert.notEqual(token2, token1, '每次启动都应换新令牌')
  assert.equal(currentImportToken(), token2)
  // 新任务必须从「未取消」起步：否则刚开的导入会立刻继承上一次的取消信号自行退出
  assert.equal(isImportCancelRequested(), false, '新任务不得继承上一次的取消信号')
})
