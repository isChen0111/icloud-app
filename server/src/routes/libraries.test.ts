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
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import {
  libraryBusyGuard,
  countAssetsCached,
  countCacheToken,
  resetCountCache,
  prepareLibrarySwitch,
} from './libraries.js'
import { syncState, resetSyncState } from '../icloudpd/state.js'
import { importState } from '../import/state.js'
import { scanProgress } from '../scanner/index.js'
import { newSession, authStatus, stopAuth } from '../icloudpd/auth.js'

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

/* ============ countAssetsCached：库计数缓存 ============ */

/** 造一个有 assets 表的临时 library.db，返回路径 */
function makeLibraryDb(dir: string): string {
  const dbPath = path.join(dir, 'library.db')
  const db = new Database(dbPath)
  db.exec(`CREATE TABLE assets (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL)`)
  db.close()
  return dbPath
}

/** 往库里的 assets 表插入 n 行指定类型 */
function insertAssets(dbPath: string, type: string, n = 1): void {
  const db = new Database(dbPath)
  const stmt = db.prepare(`INSERT INTO assets (type) VALUES (?)`)
  for (let i = 0; i < n; i++) stmt.run(type)
  db.close()
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-count-'))
  try {
    fn(dir)
  } finally {
    // 临时目录在 os.tmpdir 下，不受仓库内删除限制
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('countAssetsCached：同 token 命中缓存，不重新读库', () => {
  withTempDir((dir) => {
    resetCountCache()
    const dbPath = path.join(dir, 'library.db') // 先不存在

    // 第一次：库还没建 → 0/0，并写入缓存
    assert.deepEqual(countAssetsCached(dbPath, 't1'), { photos: 0, videos: 0 })

    // 造库并插入 3 张照片
    makeLibraryDb(dir)
    insertAssets(dbPath, 'photo', 3)

    // 同 token：仍返回缓存里的 0（证明没有重新打开数据库）
    assert.deepEqual(countAssetsCached(dbPath, 't1'), { photos: 0, videos: 0 })

    // 换 token：重算，读到真实值
    assert.deepEqual(countAssetsCached(dbPath, 't2'), { photos: 3, videos: 0 })
  })
})

test('countAssetsCached：口径与主页一致（photo + live 计入照片，video 单列）', () => {
  withTempDir((dir) => {
    resetCountCache()
    makeLibraryDb(dir)
    const dbPath = path.join(dir, 'library.db')
    insertAssets(dbPath, 'photo', 2)
    insertAssets(dbPath, 'live', 3)
    insertAssets(dbPath, 'video', 1)

    assert.deepEqual(countAssetsCached(dbPath, 'p1'), { photos: 5, videos: 1 })
  })
})

test('countAssetsCached：超过 TTL 后重算', () => {
  withTempDir((dir) => {
    resetCountCache()
    const dbPath = path.join(dir, 'library.db')
    countAssetsCached(dbPath, 'ttl') // 0/0 入缓存

    makeLibraryDb(dir)
    insertAssets(dbPath, 'video', 2)

    // TTL 内仍命中
    assert.deepEqual(countAssetsCached(dbPath, 'ttl'), { photos: 0, videos: 0 })

    // 越过 10s TTL
    const realNow = Date.now
    try {
      Date.now = () => realNow() + 10_001
      assert.deepEqual(countAssetsCached(dbPath, 'ttl'), { photos: 0, videos: 2 })
    } finally {
      Date.now = realNow
    }
  })
})

test('countAssetsCached：resetCountCache 清空缓存后重算', () => {
  withTempDir((dir) => {
    resetCountCache()
    const dbPath = path.join(dir, 'library.db')
    countAssetsCached(dbPath, 'r1')

    makeLibraryDb(dir)
    insertAssets(dbPath, 'photo', 4)

    resetCountCache()
    assert.deepEqual(countAssetsCached(dbPath, 'r1'), { photos: 4, videos: 0 })
  })
})

test('countCacheToken：包含扫描轮次/扫描状态/导入状态', () => {
  resetBusyState()
  scanProgress.runId = 7
  importState.status = 'running'
  const token = countCacheToken()
  assert.equal(token, '7:idle:running')
  assert.match(token, /^7:idle:running$/)

  // 扫描结束（状态位变化）→ token 必然变化，无需等 TTL
  scanProgress.status = 'done'
  assert.notEqual(countCacheToken(), token)

  // 收尾：不留全局单例脏状态给同文件其他用例
  resetBusyState()
  scanProgress.runId = 0
  importState.status = 'idle'
})

/* ============ 审查 C-15：切库/删库必须停掉认证会话 ============ */

test('C-15：切库前的收尾会停掉认证会话，否则旧库的验证码表单会挂在新库上', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-switch-auth-'))
  try {
    // 造一个「旧库等待验证码」的会话：cookieDir 指向旧库目录
    newSession(path.join(dir, 'cookies'), 'waiting_code', '请输入发送到设备的验证码')
    assert.ok(authStatus(), '前置条件：会话确实存在')

    prepareLibrarySwitch()

    // 停掉后 /api/auth 必须返回 null。若仍是旧会话，前端在新库界面会继续显示
    // 「等待验证码」，用户输的码也会被提交到这个属于旧库的会话里（C-15）
    assert.equal(authStatus(), null, '切库必须停掉认证会话')
  } finally {
    stopAuth()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
