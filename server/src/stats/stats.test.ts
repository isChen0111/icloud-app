/**
 * 体积缓存（stats/sizeCache.ts）与缩略图失败计数口径的单元测试
 *
 * sizeCache 的依赖全部注入，所以这里不需要真实照片库、也不需要启 Fastify：
 * 文件系统、时钟、遍历函数、任务是否在跑，全部由假 deps 驱动。
 *
 * 重点覆盖三件曾经出过问题（或极易写错）的事：
 *   ① 扫描/导入期间根本不该去遍历磁盘（否则每 5 秒重走一遍整库）；
 *   ② 遍历期间切库，结果必须整份丢弃，不能写到新库名下；
 *   ③ 数据过期期间要返回旧值，不能返回 null（否则前端体积抖动）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { createSizeCache, type SizeCacheDeps } from './sizeCache.js'
import { countThumbFailures } from '../routes/stats.js'

/** 让出一次事件循环，等 compute() 里的 await 走完 */
const tick = (): Promise<void> => new Promise<void>((r) => setImmediate(r))

interface Harness {
  deps: SizeCacheDeps
  state: {
    key: string
    root: string
    files: Map<string, string>
    quiet: boolean
    walkCalls: number
    walkBytes: number
    writeCalls: number
    written: string
    assetCount: number
    runId: number
  }
}

/** 造一套可调的假依赖 */
function makeHarness(overrides: Partial<SizeCacheDeps> = {}): Harness {
  const state: Harness['state'] = {
    key: 'lib1',
    root: 'R:/lib1',
    files: new Map<string, string>(),
    quiet: true,
    walkCalls: 0,
    walkBytes: 1024,
    writeCalls: 0,
    written: '',
    assetCount: 10,
    runId: 1,
  }
  const deps: SizeCacheDeps = {
    contextKey: () => state.key,
    libraryRoot: () => state.root,
    cachePath: () => `${state.root}/stats.json`,
    countAssets: () => state.assetCount,
    scanRunId: () => state.runId,
    isQuiet: () => state.quiet,
    walk: async () => {
      state.walkCalls += 1
      return state.walkBytes
    },
    exists: (p) => state.files.has(p),
    readFile: (p) => state.files.get(p) ?? '',
    writeFile: (p, data) => {
      state.writeCalls += 1
      state.written = data
      state.files.set(p, data)
    },
    now: () => 1_000,
    ...overrides,
  }
  return { deps, state }
}

test('sizeCache：任务运行期（isQuiet=false）不遍历磁盘', async () => {
  const { deps, state } = makeHarness({ isQuiet: () => false })
  const cache = createSizeCache(deps)

  cache.touch(10)
  cache.ensure()
  await tick()

  assert.equal(state.walkCalls, 0, '扫描/导入/同步在跑时不应发起整库遍历')
  assert.equal(cache.bytes, null, '还没算过，返回 null 而不是伪造数字')
})

test('sizeCache：任务结束后才遍历一次，落盘内容带 libraryRoot', async () => {
  let quiet = false
  const { deps, state } = makeHarness({ isQuiet: () => quiet })
  const cache = createSizeCache(deps)

  cache.ensure()
  await tick()
  assert.equal(state.walkCalls, 0)

  quiet = true
  cache.ensure()
  await tick()

  assert.equal(state.walkCalls, 1)
  assert.equal(cache.bytes, 1024)
  const written = JSON.parse(state.written) as { libraryRoot: string; totalBytes: number }
  assert.equal(written.libraryRoot, 'R:/lib1', '落盘必须写明归属库，供下次启动校验')
  assert.equal(written.totalBytes, 1024)
})

test('sizeCache：遍历期间切库 → 结果整份丢弃，不写到新库名下', async () => {
  let key = 'lib1'
  let root = 'R:/lib1'
  let release: (() => void) | null = null
  const gate = new Promise<void>((r) => {
    release = r
  })
  const { deps, state } = makeHarness({
    contextKey: () => key,
    libraryRoot: () => root,
    walk: async () => {
      state.walkCalls += 1
      await gate
      return 9999
    },
  })
  const cache = createSizeCache(deps)

  cache.ensure()
  await tick() // 遍历已经开始，卡在 gate 上

  // 切库：上下文 key 与库根都变了
  key = 'lib2'
  root = 'R:/lib2'
  release!()
  await tick()

  assert.equal(state.writeCalls, 0, '旧库的遍历结果绝不能落盘到新库')
  assert.equal(cache.bytes, null, '新库还没有自己的数据')
})

test('sizeCache：切库后重新读新库自己的 stats.json', async () => {
  let key = 'lib1'
  let root = 'R:/lib1'
  const { deps, state } = makeHarness({
    contextKey: () => key,
    libraryRoot: () => root,
    cachePath: () => `${root}/stats.json`,
  })
  state.files.set('R:/lib1/stats.json', JSON.stringify({
    libraryRoot: 'R:/lib1', totalBytes: 111, assetCount: 1, scanRunId: 1,
  }))
  state.files.set('R:/lib2/stats.json', JSON.stringify({
    libraryRoot: 'R:/lib2', totalBytes: 222, assetCount: 2, scanRunId: 1,
  }))

  const cache = createSizeCache(deps)
  assert.equal(cache.bytes, 111)

  key = 'lib2'
  root = 'R:/lib2'
  assert.equal(cache.bytes, 222, '切库后应读到新库的落盘缓存')
})

test('sizeCache：磁盘缓存 libraryRoot 与当前库不符 → 不采用', () => {
  const { deps, state } = makeHarness()
  state.files.set('R:/lib1/stats.json', JSON.stringify({
    libraryRoot: 'R:/other-lib', totalBytes: 777, assetCount: 10, scanRunId: 1,
  }))
  const cache = createSizeCache(deps)
  assert.equal(cache.bytes, null, '归属不符必须判为未命中，触发重算')
})

test('sizeCache：数据过期期间返回旧值，算完后才更新', async () => {
  const { deps, state } = makeHarness()
  const cache = createSizeCache(deps)

  cache.ensure()
  await tick()
  assert.equal(cache.bytes, 1024)

  // 资产数变化 → 标记过期；此刻新值还没算
  state.assetCount = 20
  state.walkBytes = 2048
  cache.touch(20)
  assert.equal(cache.bytes, 1024, '过期但未重算时应返回旧值，不能返回 null')

  cache.ensure()
  assert.equal(cache.bytes, 1024, '计算是异步的，同步时刻仍应读旧值')
  await tick()
  assert.equal(cache.bytes, 2048, '算完后切到新值')
})

test('sizeCache：同一时刻只有一个遍历在跑（单飞）', async () => {
  const { deps, state } = makeHarness({
    walk: async () => {
      state.walkCalls += 1
      await new Promise<void>((r) => setImmediate(r))
      return state.walkBytes
    },
  })
  const cache = createSizeCache(deps)

  cache.ensure()
  cache.ensure()
  cache.ensure()
  await tick()
  await tick()

  assert.equal(state.walkCalls, 1, '并发的 ensure 不应触发多次整库遍历')
})

test('countThumbFailures：未忽略 / 已忽略分组，NULL 视为未忽略', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-count-'))
  const dbPath = path.join(dir, 't.db')
  const db = new Database(dbPath)
  try {
    db.exec(`CREATE TABLE assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thumb_status TEXT DEFAULT 'pending',
      thumb_ignored INTEGER
    )`)
    const insert = db.prepare(`INSERT INTO assets (thumb_status, thumb_ignored) VALUES (?, ?)`)

    // 空表
    assert.deepEqual(countThumbFailures(db), { active: 0, ignored: 0 })

    // 2 条未忽略 + 1 条已忽略 + 2 条非失败态
    insert.run('error', 0)
    insert.run('error', 0)
    insert.run('error', 1)
    insert.run('done', 0)
    insert.run('pending', 0)
    assert.deepEqual(countThumbFailures(db), { active: 2, ignored: 1 })

    // 历史库可能残留 NULL：按未忽略计（与原 SQL `thumb_ignored = 0` 口径一致）
    insert.run('error', null)
    assert.deepEqual(countThumbFailures(db), { active: 3, ignored: 1 })
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
