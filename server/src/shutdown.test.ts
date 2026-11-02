/**
 * 进程收尾（审查 C-16）
 *
 * 旧实现里 app.close() / closeDb() 从未被调用，watcher.close() 的 Promise 被丢弃，
 * 于是每次重启都留孤儿子进程与未 checkpoint 的 WAL。
 *
 * 这里只断言「能被直接观测到的部分」：收尾确实执行（返回 true）、重复调用幂等、
 * 单步失败不阻断后续。watcher 是否真停用代数递增判断——stopWatcher() 的实现就是
 * 递增代数作废所有排队回调，代数是唯一外部可见的证据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { shutdown, __resetShutdownForTest } from './shutdown.js'
import { config } from './config.js'
import { getDb } from './db/index.js'
import { currentWatcherGeneration, startWatcher } from './scanner/watcher.js'

function tempEnv(): { dir: string; restore: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shutdown-'))
  const orig = { libraryRoot: config.libraryRoot, cacheDir: config.cacheDir, dbPath: config.dbPath }
  config.libraryRoot = dir
  config.cacheDir = path.join(dir, 'cache')
  config.dbPath = path.join(dir, 'library.db')
  fs.mkdirSync(config.cacheDir, { recursive: true })
  return {
    dir,
    restore: () => {
      config.libraryRoot = orig.libraryRoot
      config.cacheDir = orig.cacheDir
      config.dbPath = orig.dbPath
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('C-16：收尾会停监听、关 HTTP，且重复调用只执行一次', async () => {
  __resetShutdownForTest()
  const env = tempEnv()
  try {
    getDb().prepare('SELECT 1').get() // 制造一个真实打开的库连接（getDb 是惰性 Proxy，不访问属性不会真的打开），收尾必须能关掉它（否则 Windows 上临时目录删不掉）
    startWatcher()
    const genBefore = currentWatcherGeneration()

    let closed = 0
    const app = { close: async () => void closed++ }

    assert.equal(await shutdown(app as never, 'SIGINT'), true)
    assert.equal(closed, 1, 'HTTP 服务必须被关闭')
    assert.ok(
      currentWatcherGeneration() > genBefore,
      'watcher 必须被停（stopWatcher 的实现就是递增代数作废排队回调）',
    )

    // 第二次（例如 SIGINT 之后又收到 SIGTERM）：不能再跑一遍
    assert.equal(await shutdown(app as never, 'SIGTERM'), false)
    assert.equal(closed, 1, '重复收尾不得重复关服务')
  } finally {
    env.restore()
  }
})

test('C-16：某一步失败不阻断后续收尾（每步独立 try）', async () => {
  __resetShutdownForTest()
  const env = tempEnv()
  try {
    getDb().prepare('SELECT 1').get()
    // app.close 抛错时，后面的 closeDb 仍必须执行 —— 否则 WAL 残留、下次打开要回放
    const app = {
      close: async () => {
        throw new Error('boom')
      },
    }
    const done = await shutdown(app as never, 'uncaughtException')
    assert.equal(done, true, '单步失败不能让整体收尾半途而废')

    // 数据库连接确实被关掉了：Windows 上未关闭的库文件会让删除抛 EBUSY/EPERM。
    // （这条断言在 Linux 上没有区分力 —— unlink 已打开的文件本就允许，注释留个记号）
    assert.doesNotThrow(() => fs.rmSync(config.dbPath, { force: false }), '数据库连接未关闭')
  } finally {
    env.restore()
  }
})
