/**
 * 导入编排链路：终态必须晚于落库扫描（审查 C-06，2026-11-02）
 *
 * 旧实现里 `importDirectory` 归置完最后一个文件就把 `status='done'` 写掉，
 * 而落库的 `runScan` 还在后面（要几秒到几十秒）。前端一看到 done 就停轮询、刷新统计，
 * 此时 `assets` 表一行都没有 —— 用户看到「导入完成」，照片墙却是空的，必须手动刷新。
 *
 * 这条不变量只有跑完整条编排链才看得出来，所以这里不 mock：
 * 真建一个临时库 → 真跑 startLocalImport → 真跑 runScan → 在「观察到终态的那一瞬」
 * 立刻查 assets 表。撤掉 C-06 的改动，`assetsAtDone` 会是 0，用例直接红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { config } from '../config.js'
import { closeDb, getDb } from '../db/index.js'
import { startLocalImport } from './index.js'
import { importState, isImportBusy, resetImportState } from './state.js'
import { stopWatcher } from '../scanner/watcher.js'
import { scanProgress } from '../scanner/index.js'
import { clearThumbnailQueue } from '../pipeline/queue.js'
import type { LibraryRow } from '../db/libraries.js'

/** 用例期间改写路径配置，结束后恢复成进程启动时的值 */
const original = {
  libraryRoot: config.libraryRoot,
  cacheDir: config.cacheDir,
  dbPath: config.dbPath,
  importScanEveryFiles: config.importScanEveryFiles,
  importScanMinIntervalMs: config.importScanMinIntervalMs,
}

function countAssets(): number {
  return (getDb().prepare('SELECT COUNT(*) AS c FROM assets').get() as { c: number }).c
}

test('C-06：观察到 status=done 的那一刻，照片已经入库', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-pipeline-'))
  const libRoot = path.join(dir, 'lib')
  const src = path.join(dir, 'src')
  try {
    fs.mkdirSync(libRoot, { recursive: true })
    fs.mkdirSync(src, { recursive: true })
    for (let i = 1; i <= 3; i++) {
      await sharp({ create: { width: 6, height: 6, channels: 3, background: '#808080' } })
        .jpeg()
        .toFile(path.join(src, `P_${i}.jpg`))
    }
    config.libraryRoot = libRoot
    config.cacheDir = path.join(dir, 'cache')
    config.dbPath = path.join(dir, 'library.db')
    // 本用例不需要周期扫描（只有 3 个文件），关掉以免引入无关的时序
    config.importScanEveryFiles = 0

    resetImportState()
    // 只用到 library_root（派生 import/ 目标根），其余字段与本用例无关
    const lib = { id: 1, library_root: libRoot } as unknown as LibraryRow
    assert.equal(startLocalImport(lib, src, 'copy').ok, true)

    let sawScanning = false
    let assetsAtDone: number | null = null
    for (let i = 0; i < 4000; i++) {
      if (importState.phase === 'scanning') sawScanning = true
      if (importState.finishedAt != null) {
        assetsAtDone = (getDb().prepare('SELECT COUNT(*) AS c FROM assets').get() as { c: number }).c
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 1))
    }

    assert.ok(assetsAtDone !== null, '导入应在合理时间内结束')
    assert.equal(importState.status, 'done')
    assert.equal(assetsAtDone, 3, 'status 变 done 时必须已经入库（C-06 的核心不变量）')
    assert.equal(sawScanning, true, '中间应经过 phase=scanning 这个阶段')
    assert.equal(importState.phase, 'idle', '终态写回后阶段复位')
    assert.equal(isImportBusy(), false, '结束后忙碌位必须释放，否则切库/删库全被卡死')
  } finally {
    // 先等流水线真正收尾（落库扫描结束）再拆环境：
    // 用例失败时（比如断言在 scanning 阶段就红）流水线还在跑，它的 finally 会 startWatcher()，
    // 若不等待，清理后监听会被重新拉起来——而且指向已恢复的 config，即真实的照片库。
    for (let i = 0; i < 600; i++) {
      if (!isImportBusy() && scanProgress.status !== 'scanning') break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    // watcher 会一直持有临时目录的句柄，必须先停；缩略图队列同理（本用例扫出了 3 个待生成项）
    stopWatcher()
    clearThumbnailQueue()
    resetImportState()
    closeDb()
    config.libraryRoot = original.libraryRoot
    config.cacheDir = original.cacheDir
    config.dbPath = original.dbPath
    config.importScanEveryFiles = original.importScanEveryFiles
    config.importScanMinIntervalMs = original.importScanMinIntervalMs
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * 边导边看：归置期间就要能扫出入库，照片墙不必等到全部归置结束。
 *
 * 断言方式是「在 phase 仍是 copying 时观察 scanProgress.runId」——runId 在
 * doRunScan 一开始就自增，不依赖那轮扫描跑完，所以不会因为扫描比拷贝慢而假红。
 * 若周期扫描被去掉，runIdWhileCopying 会一直停在起始值。
 */
test('导入归置期间就会周期扫描：copying 阶段照片墙已有照片', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-periodic-'))
  const libRoot = path.join(dir, 'lib')
  const src = path.join(dir, 'src')
  const N = 200
  // 文件够多才有一轮扫描能在归置结束前跑完（3 个文件的拷贝比扫描还快）
  for (let i = 1; i <= N; i++) {
    fs.mkdirSync(src, { recursive: true })
    await sharp({ create: { width: 6, height: 6, channels: 3, background: '#808080' } })
      .jpeg()
      .toFile(path.join(src, `P_${String(i).padStart(3, '0')}.jpg`))
  }
  try {
    config.libraryRoot = libRoot
    config.cacheDir = path.join(dir, 'cache')
    config.dbPath = path.join(dir, 'library.db')
    config.importScanEveryFiles = 20
    config.importScanMinIntervalMs = 0

    resetImportState()
    const lib = { id: 1, library_root: libRoot } as unknown as LibraryRow
    const runIdStart = scanProgress.runId
    let runIdWhileCopying = runIdStart
    let assetsWhileCopying = 0

    assert.equal(startLocalImport(lib, src, 'copy').ok, true)
    for (let i = 0; i < 20_000; i++) {
      if (importState.phase === 'copying') {
        runIdWhileCopying = Math.max(runIdWhileCopying, scanProgress.runId)
        assetsWhileCopying = Math.max(assetsWhileCopying, countAssets())
      }
      if (importState.finishedAt != null) break
      await new Promise((resolve) => setTimeout(resolve, 1))
    }

    assert.ok(runIdWhileCopying > runIdStart, '归置阶段内必须已经派发过扫描（否则照片墙要等到全部归置完）')
    assert.ok(assetsWhileCopying > 0, '归置还没结束，库里就应该已经有照片了')
    assert.equal(countAssets(), N, '结尾的最终扫描仍要把照片全部收进来')
    assert.equal(importState.status, 'done')
  } finally {
    for (let i = 0; i < 600; i++) {
      if (!isImportBusy() && scanProgress.status !== 'scanning') break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    stopWatcher()
    clearThumbnailQueue()
    resetImportState()
    closeDb()
    config.libraryRoot = original.libraryRoot
    config.cacheDir = original.cacheDir
    config.dbPath = original.dbPath
    config.importScanEveryFiles = original.importScanEveryFiles
    config.importScanMinIntervalMs = original.importScanMinIntervalMs
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
