/**
 * icloudpd 同步状态机单元测试（审查 P3a/P3b）：
 * - P3a：进程 exit 后 error 是终态——具体文案不被通用异常覆盖；
 * - P3b：索引重试耗尽后置 error 并杀进程，后续 exit 0 不得翻转 done。
 *
 * 直接调用抽出的 handleSyncExit / handleLine（sync.ts 导出），不 spawn 真实进程：
 * killProcess 仅在 proc 非空时执行 taskkill，测试中 proc 恒为 null，无副作用。
 * meta.db 指向临时目录，避免 handleSyncExit 正常路径的 touchLibrarySync 污染真实注册表。
 */
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { LibraryRow } from '../db/libraries.js'

// 隔离 meta.db：必须在 sync.js 之前改 config.metaDbPath。
// getMetaDb() 是懒加载单例（首次调用才建库），此处改动早于任何取用者，等效于换了一个注册表。
// 2026-11-01 起不再支持 META_DB_PATH 环境变量，测试改为直接改配置字段（与 scan/migrate 测试一致）。
const { config } = await import('../config.js')
config.metaDbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'icloud-sync-test-')), 'meta.db')

const { handleSyncExit, handleLine, clearTimers, resetRetries, startSync, isSyncBusy } = await import('./sync.js')
const { getMetaDb, getLibraryById } = await import('../db/libraries.js')
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

test('handleSyncExit：旧进程迟到的 exit 不归它管（审查 C-04）', () => {
  resetSyncState()
  syncState.status = 'running'
  syncState.message = '全量拉取开始…'

  // 模拟「取消后立刻再点同步」：旧进程已被 taskkill，proc 已被新进程接管；
  // 但 libuv 的 exit 事件可能在新任务启动之后才送达。此时 proc !== child，
  // 旧事件的终态写入必须被丢弃，否则新任务会被写成 error（用户看到 error 再点一次
  // 就出现两个 icloudpd 同时写同一库目录）。
  const staleChild = { pid: 111 } as unknown as Parameters<typeof handleSyncExit>[2]
  handleSyncExit(1, lib, staleChild)

  assert.equal(syncState.status, 'running', '旧进程的退出不得改写当前任务状态')
  assert.equal(syncState.message, '全量拉取开始…')
})

test('handleSyncExit：不传 child 时保持原行为（向后兼容与已有用例）', () => {
  resetSyncState()
  syncState.status = 'running'
  handleSyncExit(0, lib)
  assert.equal(syncState.status, 'done')
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

/* ============ 2026-11-03：同步前置守卫（auth_status + cookie 实体） ============ */

/**
 * 在临时 meta.db 里造一条真实库记录。
 *
 * 为什么不直接用手写的 `lib` 常量：cookie 缺失时守卫会把库状态改成 expired，
 * 「改没改」必须回库读，只有真行才能验证（UPDATE 打在不存在的 id 上是静默 0 行，
 * 只断言返回值会漏掉这条副作用）。
 */
function seedLibrary(id: number, patch: Partial<LibraryRow>): LibraryRow {
  const row: LibraryRow = { ...lib, id, name: `lib-${id}`, ...patch }
  getMetaDb()
    .prepare(
      `INSERT OR REPLACE INTO libraries
         (id, name, library_root, cache_dir, cookie_dir, account, auth_status, last_sync_at, created_at, active, until_found, recent_limit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id, row.name, row.library_root, row.cache_dir, row.cookie_dir,
      row.account, row.auth_status, row.last_sync_at, row.created_at,
      row.active, row.until_found, row.recent_limit,
    )
  return row
}

/** 造一个「主 cookie 已落盘」的 cookie 目录 */
function cookieDirWithCookie(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-cookie-'))
  fs.writeFileSync(path.join(dir, 'user@example.com'), 'cookie')
  return dir
}

test('startSync：有 account 但 auth_status=none（提交邮箱后从未认证成功）→ 拒绝', () => {
  resetSyncState()
  const dir = cookieDirWithCookie()
  try {
    // 这正是 bug 的现场：点过「登录」、只填了邮箱，account 已写库，但从未完成验证
    seedLibrary(991, { account: 'user@example.com', auth_status: 'none', cookie_dir: dir })
    // 变异验证：把守卫改回 `if (!lib.account)` 时，这一行会真的 spawn 进程并返回 ok:true
    const r = startSync(getLibraryById(991)!, 'full')
    assert.equal(r.ok, false, 'account 有值不等于已认证，不能放行')
    assert.match(r.message, /尚未完成 iCloud 链接/)
    assert.equal(isSyncBusy(), false, '被拒的任务不得留下 running 状态')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('startSync：auth_status=expired → 拒绝并提示重新登录', () => {
  resetSyncState()
  const dir = cookieDirWithCookie()
  try {
    seedLibrary(992, { account: 'user@example.com', auth_status: 'expired', cookie_dir: dir })
    const r = startSync(getLibraryById(992)!, 'inc')
    assert.equal(r.ok, false)
    assert.match(r.message, /已过期/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('startSync：状态说已链接但 cookie 不在盘 → 拒绝，并把库状态修正为 expired', () => {
  resetSyncState()
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-nocookie-'))
  try {
    seedLibrary(993, { account: 'user@example.com', auth_status: 'authed', cookie_dir: emptyDir })
    const r = startSync(getLibraryById(993)!, 'full')
    assert.equal(r.ok, false)
    assert.match(r.message, /cookie 文件缺失/)
    assert.equal(getLibraryById(993)!.auth_status, 'expired', '状态与磁盘不符时要自愈成 expired，提示用户重登')
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true })
  }
})

test('startSync：authed 且 cookie 在盘 → 放行（守卫不得过度拦截）', async () => {
  resetSyncState()
  const dir = cookieDirWithCookie()
  const prevExe = config.icloudpdExe
  try {
    seedLibrary(994, { account: 'user@example.com', auth_status: 'authed', cookie_dir: dir })
    // 指向不存在的可执行文件：只为证明守卫放过，进程起不来（spawn error 落 error 状态）
    config.icloudpdExe = path.join(dir, 'no-such-icloudpd.exe')
    const r = startSync(getLibraryById(994)!, 'full')
    assert.equal(r.ok, true, '正常库必须能启动，否则守卫就是过度拦截')
    // 等 spawn 的 error 事件落定，避免异步状态写进后续用例
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(syncState.status, 'error')
  } finally {
    config.icloudpdExe = prevExe
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
