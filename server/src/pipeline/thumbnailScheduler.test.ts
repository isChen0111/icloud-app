/**
 * 缩略图调度器单元测试（node:test，零新增依赖）
 *
 * 覆盖 F-01 修复的核心不变量与事件让位行为（2026-10-07）：
 *  - 总运行数严格 ≤ concurrency（8 后台运行中 + 交互任务不再产生 9 个并发）
 *  - 交互任务排队插队（priority 优先于先来后到）
 *  - 后台填槽：交互任务不足时后台填满剩余槽位（零槽位浪费，原「浏览租约挂起」已移除）
 *  - 积压计数（排队 + 运行）
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
    const scheduler = new ThumbnailScheduler({ concurrency: 8 })

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
    const scheduler = new ThumbnailScheduler({ concurrency: 4 })
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
    const scheduler = new ThumbnailScheduler({ concurrency: 2 })
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
    const scheduler = new ThumbnailScheduler({ concurrency: 1 })
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

  test('后台占满时交互插队：释放槽位后交互先于后续后台执行', async () => {
    const scheduler = new ThumbnailScheduler({ concurrency: 2 })

    // 2 个后台慢任务占满槽位
    const gates = Array.from({ length: 2 }, () => makeGate())
    const bg1 = gates.map(({ gate }) => scheduler.submit(() => gate, 'background'))
    await waitFor(() => scheduler.runningCount === 2)

    // 1 个后台（排队）+ 1 个交互（排队，priority 10 应排更前）
    let bgRan = false
    const bg2 = scheduler.submit(async () => {
      bgRan = true
    }, 'background')
    let ivRan = false
    const { gate: ivGate, release: releaseIv } = makeGate()
    const iv = scheduler.submit(async () => {
      ivRan = true
      await ivGate // 挂住不完成，保证断言期间交互仍在运行
    }, 'interactive')
    await delay(10)
    assert.equal(ivRan, false, '槽位未释放前交互也应排队')

    // 释放一个槽位 → 交互应先执行（而非排队的后台）
    gates[0].release()
    await waitFor(() => ivRan === true)
    await delay(10)
    assert.equal(bgRan, false, '交互应插队先于后台任务执行')

    releaseIv()
    gates[1].release()
    await Promise.all([...bg1, bg2, iv])
    assert.equal(bgRan, true, '后台任务最终也会执行')
  })
})

describe('ThumbnailScheduler 后台填槽（事件让位）', () => {
  test('交互任务不足时后台填满剩余槽位：1 交互 + 7 后台同时运行（零槽位浪费）', async () => {
    const scheduler = new ThumbnailScheduler({ concurrency: 8 })

    // 7 个后台慢任务先入队运行
    const gates = Array.from({ length: 7 }, () => makeGate())
    const bgJobs = gates.map(({ gate }) => scheduler.submit(() => gate, 'background'))
    await waitFor(() => scheduler.runningCount === 7)

    // 1 个交互任务 → 立即用掉剩余槽位，且不排斥后台占槽
    const { gate: ivGate, release: releaseIv } = makeGate()
    const iv = scheduler.submit(async () => ivGate, 'interactive')
    await waitFor(() => scheduler.runningCount === 8)
    assert.equal(scheduler.metrics().interactiveRunning, 1, '交互运行中计数应为 1')
    assert.equal(scheduler.runningCount, 8, '8 槽全忙：7 后台 + 1 交互，无空槽浪费')

    releaseIv()
    for (const { release } of gates) release()
    await Promise.all(bgJobs)
    assert.equal(await iv, undefined)
    assert.equal(scheduler.runningCount, 0)
  })

  test('无交互任务时后台任务立即执行，不等任何时间（原 30s 租约已移除）', async () => {
    const scheduler = new ThumbnailScheduler({ concurrency: 2 })
    let ran = false
    const job = scheduler.submit(async () => {
      ran = true
    }, 'background')
    await waitFor(() => ran === true, 500)
    await job
    assert.equal(ran, true, '后台任务应入队即执行，不受任何浏览/时间状态影响')
  })
})

describe('ThumbnailScheduler 积压计数', () => {
  test('queuedCount = 排队 + 运行', async () => {
    const scheduler = new ThumbnailScheduler({ concurrency: 1 })

    // 交互任务用门闩保持运行中
    const { gate: interactiveGate, release: releaseInteractive } = makeGate()
    const interactive = scheduler.submit(async () => interactiveGate, 'interactive')
    await waitFor(() => scheduler.runningCount === 1)
    assert.equal(scheduler.queuedCount(), 1, '运行中的任务计入积压')

    const background = scheduler.submit(async () => 'bg', 'background') // 排队
    await delay(10)
    assert.equal(scheduler.queuedCount(), 2, '排队 + 运行 = 2')

    releaseInteractive()
    await Promise.all([interactive, background])
    assert.equal(scheduler.queuedCount(), 0, '全部完成后积压归零')
  })
})

describe('ThumbnailScheduler 队列指标（F-02）', () => {
  test('interactiveRunning / interactiveWaiting 计数正确（运行中与排队中分别统计）', async () => {
    const scheduler = new ThumbnailScheduler({ concurrency: 1 })

    // ① 交互任务 A 用门闩保持运行中（避免瞬间完成导致断言竞态）
    const { gate, release } = makeGate()
    const jobA = scheduler.submit(async () => gate, 'interactive')
    await waitFor(() => scheduler.runningCount === 1)
    assert.equal(scheduler.metrics().interactiveRunning, 1, 'A 运行中：交互运行应为 1')
    assert.equal(scheduler.metrics().interactiveWaiting, 0, 'A 已开始执行，不应计为等待')

    // ② 交互任务 B 入队排队（concurrency=1 被 A 占满）
    const jobB = scheduler.submit(async () => 'b', 'interactive')
    assert.equal(scheduler.metrics().interactiveWaiting, 1, 'B 排队中：交互等待应为 1')
    assert.equal(scheduler.metrics().interactiveRunning, 1, 'A 仍在运行：交互运行保持 1')

    // ③ 释放 A → B 自动派发并完成，计数全部归零
    release()
    await Promise.all([jobA, jobB])
    assert.equal(scheduler.metrics().interactiveRunning, 0, '全部完成后交互运行归零')
    assert.equal(scheduler.metrics().interactiveWaiting, 0, '全部完成后交互等待归零')
    assert.equal(scheduler.metrics().running, 0)
  })

  test('cancelled 累计客户端断开被跳过的请求数', async () => {
    const scheduler = new ThumbnailScheduler({ concurrency: 8 })
    assert.equal(scheduler.metrics().cancelled, 0, '初始应为 0')

    scheduler.registerCancelled()
    scheduler.registerCancelled()
    scheduler.registerCancelled()
    assert.equal(scheduler.metrics().cancelled, 3, '三次跳过应累计为 3')

    // 只读计数不参与并发/积压统计
    assert.equal(scheduler.runningCount, 0)
    assert.equal(scheduler.queuedCount(), 0)
  })
})
