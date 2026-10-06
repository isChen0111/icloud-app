/**
 * 缩略图调度器单元测试（node:test，零新增依赖）
 *
 * 覆盖 F-01 修复的核心不变量与行为：
 *  - 总运行数严格 ≤ concurrency（8 后台运行中 + 交互任务不再产生 9 个并发）
 *  - 交互任务排队插队（priority 优先于先来后到）
 *  - 浏览租约：浏览期间后台挂起不派发、交互照常、租约到期恢复
 *  - 积压计数（排队 + 运行 + 挂起）
 *
 * 运行：npm test（server 目录）
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { ThumbnailScheduler } from './thumbnailScheduler.js'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 轮询等待条件成立（异步测试用） */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor 超时：条件未在 ${timeoutMs}ms 内成立`)
    await delay(5)
  }
}

/** 手动释放的慢任务门闩：创建时立即返回一个可手动 resolve 的 gate 与对应 job */
function makeGate(): { gate: Promise<void>; release: () => void } {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return { gate, release }
}

describe('ThumbnailScheduler 并发不变量', () => {
  test('F-01 复现：8 个后台运行中 + 交互任务 → 总运行数 ≤ 8（旧实现会到 9）', async () => {
    const scheduler = new ThumbnailScheduler({ concurrency: 8, browseLeaseMs: 30_000 })

    // ① 塞满 8 个后台慢任务（各自挂在一个可手动释放的门闩上）
    const gates = Array.from({ length: 8 }, () => makeGate())
    const backgroundJobs = gates.map(({ gate }) => scheduler.submit(() => gate, 'background'))
    await waitFor(() => scheduler.runningCount === 8)

    // ② 在 8 个后台任务运行中时加入 1 个交互任务（F-01 的触发场景）
    const interactive = scheduler.submit(async () => 'interactive-done', 'interactive')
    await delay(20) // 给调度器留出派发时间

    // ③ 断言：总运行数严格 ≤ 8
    assert.ok(scheduler.runningCount <= 8, `运行数 ${scheduler.runningCount} 不应超过 8`)

    // ④ 逐个释放后台任务，确认 9 个任务全部最终完成、交互任务结果正确
    for (const { release } of gates) release()
    await Promise.all(backgroundJobs)
    assert.equal(await interactive, 'interactive-done')
    assert.equal(scheduler.runningCount, 0, '全部完成后运行数应归零')
  })

  test('批量并发：40 个任务在 concurrency=4 下最大运行数 ≤ 4', async () => {
    const scheduler = new ThumbnailScheduler({ concurrency: 4, browseLeaseMs: 30_000 })
    let running = 0
    let maxRunning = 0
    const job = async () => {
      running++
      maxRunning = Math.max(maxRunning, running)
      await delay(10)
      running--
    }
    await Promise.all(Array.from({ length: 40 }, () => scheduler.submit(job, 'background')))
    assert.ok(maxRunning <= 4, `最大运行数 ${maxRunning} 不应超过 4`)
    assert.equal(running, 0)
  })

  test('并发占满时新任务排队等待，完成后自动派发', async () => {
    const scheduler = new ThumbnailScheduler({ concurrency: 2, browseLeaseMs: 30_000 })
    const gates = Array.from({ length: 2 }, () => makeGate())
    const first = gates.map(({ gate }) => scheduler.submit(() => gate, 'background'))
    await waitFor(() => scheduler.runningCount === 2)

    let thirdRan = false
    const third = scheduler.submit(async () => {
      thirdRan = true
    }, 'background')
    await delay(20)
    assert.equal(thirdRan, false, '并发占满时第三个任务应排队等待')
    assert.equal(scheduler.runningCount, 2)

    // 释放一个槽位 → 排队任务自动开始
    gates[0].release()
    await third
    assert.equal(thirdRan, true)
    gates[1].release() // 释放第二个后台任务，避免测试挂起
    await Promise.all(first)
  })
})

describe('ThumbnailScheduler 交互优先', () => {
  test('后台积压时交互任务插队先执行（concurrency=1 下顺序为 A → I → B）', async () => {
    const scheduler = new ThumbnailScheduler({ concurrency: 1, browseLeaseMs: 30_000 })
    const order: string[] = []
    const { gate, release } = makeGate()

    // A（后台）先入队并立即运行（concurrency=1 独占）
    const jobA = scheduler.submit(async () => {
      order.push('A')
      await gate
    }, 'background')
    // B（后台）入队 → 排队等待
    const jobB = scheduler.submit(async () => {
      order.push('B')
    }, 'background')
    // I（交互）后入队 → priority 10，应插到 B 前面
    const jobI = scheduler.submit(async () => {
      order.push('I')
    }, 'interactive')

    await waitFor(() => order.length === 1)
    assert.deepEqual(order, ['A'], '初始只有 A 在运行')

    release() // A 完成 → 释放唯一槽位
    await Promise.all([jobA, jobI, jobB])
    assert.deepEqual(order, ['A', 'I', 'B'], '交互任务 I 应插队先于后台任务 B 执行')
  })
})

describe('ThumbnailScheduler 浏览租约', () => {
  test('浏览期间后台挂起不派发、交互照常执行、租约到期后后台放行', async () => {
    const scheduler = new ThumbnailScheduler({ concurrency: 1, browseLeaseMs: 100 })
    scheduler.markBrowsing()

    let backgroundRan = false
    const background = scheduler.submit(async () => {
      backgroundRan = true
    }, 'background')

    await delay(20)
    assert.equal(scheduler.runningCount, 0, '浏览期间后台任务应挂起，不占用槽位')
    assert.equal(backgroundRan, false)

    // 浏览期间交互任务不受影响，立即执行
    const interactive = scheduler.submit(async () => 'ok', 'interactive')
    assert.equal(await interactive, 'ok')

    // 注意：调度器内部恢复定时器是 unref 的（真实服务靠 HTTP 等句柄保持事件循环）。
    // 测试里必须用 ref 的 delay 保持事件循环活动，等租约（100ms）到期放行后再断言。
    await delay(120)
    assert.equal(backgroundRan, true, '租约到期后后台任务应被放行')
    await background // 此时 promise 已 resolve，立即返回
  })

  test('浏览租约可刷新：再次浏览活动延长后台挂起时间', async () => {
    const scheduler = new ThumbnailScheduler({ concurrency: 1, browseLeaseMs: 100 })
    scheduler.markBrowsing()
    let backgroundRan = false
    const background = scheduler.submit(async () => {
      backgroundRan = true
    }, 'background')

    await delay(60)
    scheduler.markBrowsing() // 刷新租约，重新计时 100ms

    await delay(80) // 距首次 markBrowsing 已 140ms > 100ms，但租约已被刷新
    assert.equal(backgroundRan, false, '刷新租约后后台仍应挂起')

    await delay(120) // 保持事件循环活动，等刷新后的租约（t≈160ms）到期放行
    assert.equal(backgroundRan, true, '刷新后的租约到期后后台应执行')
    await background // 已 resolve，立即返回
  })
})

describe('ThumbnailScheduler 积压计数', () => {
  test('queuedCount = 排队 + 运行 + 浏览挂起', async () => {
    const scheduler = new ThumbnailScheduler({ concurrency: 1, browseLeaseMs: 200 })
    scheduler.markBrowsing()

    const background = scheduler.submit(async () => 'bg', 'background') // 挂起
    await delay(10)
    assert.equal(scheduler.queuedCount(), 1, '挂起的后台任务应计入积压')

    // 交互任务用门闩保持运行中，避免瞬间完成导致断言竞态
    const { gate: interactiveGate, release: releaseInteractive } = makeGate()
    const interactive = scheduler.submit(async () => interactiveGate, 'interactive') // 运行中
    await waitFor(() => scheduler.runningCount === 1)
    assert.equal(scheduler.queuedCount(), 2, '运行中的交互任务 + 挂起的后台任务 = 2')

    releaseInteractive()
    await interactive
    assert.equal(scheduler.queuedCount(), 1, '交互完成后只剩挂起的后台任务')

    await delay(220) // 保持事件循环活动，等租约（200ms）到期放行并执行完成
    assert.equal(scheduler.queuedCount(), 0, '后台放行执行完成后积压归零')
    await background // 已 resolve，立即返回
  })
})
