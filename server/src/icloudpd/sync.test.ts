/**
 * icloudpd 同步状态机单元测试（审查 P3a/P3b）：
 * - P3a：进程 exit 后 error 是终态——具体文案不被通用异常覆盖；
 * - P3b：索引重试耗尽后置 error 并杀进程，后续 exit 0 不得翻转 done。
 *
 * 直接调用抽出的 handleSyncExit / handleLine（sync.ts 导出），不 spawn 真实进程：
 * killProcess 仅在 proc 非空时执行 taskkill，测试中 proc 恒为 null，无副作用。
 * META_DB_PATH 指向临时目录，避免 handleSyncExit 正常路径的 touchLibrarySync 污染真实 meta.db。
 */
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { LibraryRow } from '../db/libraries.js'

// 必须在 import sync.js（连带 config.js）之前设置，隔离 meta.db
process.env.META_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'icloud-sync-test-')), 'meta.db')

const { handleSyncExit, handleLine, clearTimers, resetRetries } = await import('./sync.js')
const { syncState, resetSyncState } = await import('./state.js')

// 重试路径会挂 60s retryTimer、retries 为模块级计数：每个用例后清理，
// 避免测试进程被残留 timer 拖住不退出、以及重试计数跨用例泄漏
afterEach(() => {
  clearTimers()
  resetSyncState()
  resetRetries()
})

const lib: LibraryRow = {
  id: 999,
  name: 'test-lib',
  library_root: 'C:\\tmp\\lib999',
  cache_dir: 'C:\\tmp\\cache999',
  cookie_dir: 'C:\\tmp\\cookie999',
  account: 'test@example.com',
  auth_status: 'authed',
  last_sync_at: null,
  created_at: new Date().toISOString(),
  active: 1,
  until_found: 20,
  recent_limit: 0,
}

test('handleSyncExit：正常退出 0 → done + 完成时间', () => {
  resetSyncState()
  syncState.status = 'running'
  handleSyncExit(0, lib)
  assert.equal(syncState.status, 'done')
  assert.equal(syncState.message, '同步完成')
  assert.ok(syncState.finishedAt, '应记录完成时间')
})

test('handleSyncExit：非零退出 → error + 带退出码文案', () => {
  resetSyncState()
  syncState.status = 'running'
  handleSyncExit(2, lib)
  assert.equal(syncState.status, 'error')
  assert.match(syncState.message, /icloudpd 异常退出（code=2）/)
})

test('handleSyncExit：cancelled → 不覆盖状态', () => {
  resetSyncState()
  syncState.status = 'cancelled'
  syncState.message = '任务已取消'
  handleSyncExit(0, lib)
  assert.equal(syncState.status, 'cancelled')
  assert.equal(syncState.message, '任务已取消')
})

test('handleSyncExit：waiting_retry → 不覆盖（重试定时器已接管）', () => {
  resetSyncState()
  syncState.status = 'waiting_retry'
  syncState.message = '等待重试'
  handleSyncExit(0, lib)
  assert.equal(syncState.status, 'waiting_retry')
  assert.equal(syncState.message, '等待重试')
})

test('handleSyncExit：error 终态不被 exit 0 覆盖（P3a）', () => {
  resetSyncState()
  syncState.status = 'error'
  syncState.message = 'iCloud 会话已过期，请重新链接后再同步'
  syncState.finishedAt = '2026-10-18T00:00:00.000Z'
  handleSyncExit(0, lib)
  assert.equal(syncState.status, 'error')
  assert.equal(syncState.message, 'iCloud 会话已过期，请重新链接后再同步')
  assert.equal(syncState.finishedAt, '2026-10-18T00:00:00.000Z', '具体文案/时间不得被 exit 覆盖')
})

test('handleSyncExit：error 终态不被非零 exit 覆盖（P3a）', () => {
  resetSyncState()
  syncState.status = 'error'
  syncState.message = 'iCloud 索引长时间未就绪（已重试 5 次），请稍后再试'
  handleSyncExit(1, lib)
  assert.equal(syncState.status, 'error')
  assert.equal(syncState.message, 'iCloud 索引长时间未就绪（已重试 5 次），请稍后再试')
})

test('handleLine：索引未就绪自动重试 → 计数递增、状态 waiting_retry', () => {
  resetSyncState()
  syncState.status = 'running'
  handleLine('INFO has not finished indexing yet, waiting 5 minutes')
  assert.equal(syncState.status, 'waiting_retry')
  assert.match(syncState.message, /第 1\/5 次/)
})

test('handleLine：重试耗尽（5 次后）→ error + 完成时间（P3b）', () => {
  resetSyncState()
  syncState.status = 'running'
  // 前 5 次：每次命中后状态为 waiting_retry，模拟重试定时器触发后回到 running
  for (let i = 0; i < 5; i++) {
    handleLine('has not finished indexing')
    assert.equal(syncState.status, 'waiting_retry', `第 ${i + 1} 次应进入等待重试`)
    syncState.status = 'running'
  }
  // 第 6 次（重试耗尽）：retries=5 不再 < MAX_RETRIES → error + 杀进程
  handleLine('has not finished indexing')
  assert.equal(syncState.status, 'error')
  assert.match(syncState.message, /已重试 5 次/)
  assert.ok(syncState.finishedAt, '耗尽后应记录完成时间')
})

test('handleLine：重试耗尽后进程自行退出 0 → 不翻转 done（P3b 关键回归）', () => {
  resetSyncState()
  syncState.status = 'running'
  for (let i = 0; i < 5; i++) {
    handleLine('has not finished indexing')
    syncState.status = 'running'
  }
  handleLine('has not finished indexing')
  assert.equal(syncState.status, 'error')
  // 进程随后自行退出 0（如后台下载恰好完成）：不得 error→done 翻转、不得更新 last_sync_at
  handleSyncExit(0, lib)
  assert.equal(syncState.status, 'error', 'error 终态不得被 exit 0 翻转为 done')
  assert.match(syncState.message, /已重试 5 次/)
})

test('handleLine：会话失效输出 → error + 过期文案', () => {
  resetSyncState()
  syncState.status = 'running'
  handleLine('ERROR: Authentication required. Please log in again.')
  assert.equal(syncState.status, 'error')
  assert.match(syncState.message, /会话已过期/)
})
