/**
 * 目录热监听的会话代数测试（R-11）
 *
 * 这里只钉住最容易被"简化"掉的那半条约束：**stopWatcher 必须递增代数**。
 * 真正的端到端行为（stop 之后 chokidar 迟到事件不触发 runScan）依赖 2s 的
 * awaitWriteFinish 与真实扫描，跑起来会污染全局 config/db，不适合放单测；
 * 那部分靠手工验证：切库时后端日志不应出现对新库的 [watcher] 全量扫描。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { config } from '../config.js'
import { currentWatcherGeneration, startWatcher, stopWatcher } from './watcher.js'

/** chokidar 的 close() 是 fire-and-forget，Windows 上要等句柄真正释放才能删目录 */
function waitHandleRelease(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 150))
}

test('startWatcher 开启新会话，stopWatcher 递增代数作废旧会话（R-11）', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icloud-watch-'))
  const prevRoot = config.libraryRoot

  t.after(async () => {
    stopWatcher()
    config.libraryRoot = prevRoot
    await waitHandleRelease()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  config.libraryRoot = dir

  const g0 = currentWatcherGeneration()
  startWatcher()
  const g1 = currentWatcherGeneration()
  assert.equal(g1, g0 + 1, 'startWatcher 应开启新会话（代数 +1）')

  stopWatcher()
  const g2 = currentWatcherGeneration()
  assert.equal(
    g2,
    g1 + 1,
    'stopWatcher 必须递增代数：否则换库前已排队的 chokidar 事件仍会调用 scheduleScan，' +
      '1.5s 后对刚切过去的新库白跑一次全量扫描',
  )

  // 停止后再启动：继续开新会话，上一代（g1/g2）永久失效
  startWatcher()
  assert.equal(currentWatcherGeneration(), g2 + 1, 'stop 之后 start 应继续递增，不复用已作废的代数')
})

test('重复 startWatcher 不新开会话（幂等，避免多个 watcher 抢同一目录）', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icloud-watch-'))
  const prevRoot = config.libraryRoot

  t.after(async () => {
    stopWatcher()
    config.libraryRoot = prevRoot
    await waitHandleRelease()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  config.libraryRoot = dir

  startWatcher()
  const g1 = currentWatcherGeneration()
  startWatcher()
  assert.equal(currentWatcherGeneration(), g1, '第二次 startWatcher 是空操作，不应递增代数')
})
