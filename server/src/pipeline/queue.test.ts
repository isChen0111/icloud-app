/**
 * 缩略图队列的两个不变量（2026-10-28，审查第二批 R-06 / R-07）
 *
 * R-06：切库时不得让排队任务的 Promise 悬挂。
 *   历史实现调用 p-queue 的 clear()，其源码是 `#queue = new Queue()`——
 *   直接把待办队列换掉，排队任务的 Promise 既不 resolve 也不 reject，
 *   `await` 它们的 /api/thumb 请求会永远挂着（浏览器同域 6 个连接很快被占死）。
 *   现改为「世代令牌」：任务照常留在队列里，轮到时发现世代不符就立即返回 null。
 *
 * R-07：in-flight 去重键必须带库标识。
 *   资产 id 是每个库各自从 1 自增的，lib1 的 id=42 与 lib6 的 id=42 是两张不同的照片；
 *   键里若不区分库，切库后会复用旧库在途的 Promise，拿回旧库的缩略图路径（照片墙串图）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { config } from '../config.js'
import { clearThumbnailQueue, runInteractiveThumbnail } from './queue.js'
import { inFlightKey } from './thumbnails.js'

test('R-06：换代后排队中的任务立即结束，Promise 不悬挂', async () => {
  // 占满全部并发槽位（槽位数 = config.thumbConcurrency，默认 8）
  const budget = Math.max(1, config.thumbConcurrency)
  const release: (() => void)[] = []
  const blockers = Array.from({ length: budget }, () =>
    runInteractiveThumbnail(() => new Promise<void>((resolve) => release.push(resolve))),
  )
  // 等占位任务真正开始执行（scheduler.submit → 微任务队列）
  await new Promise((resolve) => setTimeout(resolve, 20))

  // 槽位已满 → 这个任务只能排队
  let taskBodyRan = false
  const queued = runInteractiveThumbnail(async () => {
    taskBodyRan = true
    return 'should-not-run'
  })
  await new Promise((resolve) => setTimeout(resolve, 20))

  // 模拟切库：世代 +1
  clearThumbnailQueue()
  // 释放占位任务，让队列前进到那个排队任务
  for (const done of release) done()

  // 关键断言：它必须很快结束（而不是永久 pending）
  const result = await Promise.race([
    queued,
    new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 500)),
  ])
  assert.equal(result, null, '换代后的排队任务应空转返回 null')
  assert.notEqual(result, 'TIMEOUT', '排队任务的 Promise 不得悬挂')
  assert.equal(taskBodyRan, false, '换代后不应真正执行任务体（避免用旧 id 查新库）')

  await Promise.all(blockers)
})

test('R-07：in-flight 键带库标识，不同库的同 id 不共键', () => {
  const a = inFlightKey(42, 'grid', '/tmp/lib1/library.db')
  const b = inFlightKey(42, 'grid', '/tmp/lib6/library.db')
  assert.notEqual(a, b, '两个库的 id=42 是不同照片，键必须不同')
  // 同库同 id 同档位 → 必须相同（否则去重失效，同一资产会被并发生成两次）
  assert.equal(a, inFlightKey(42, 'grid', '/tmp/lib1/library.db'))
  // 同库同 id 不同档位 → 也必须不同（grid / detail 是两档缓存）
  assert.notEqual(a, inFlightKey(42, 'detail', '/tmp/lib1/library.db'))
})
