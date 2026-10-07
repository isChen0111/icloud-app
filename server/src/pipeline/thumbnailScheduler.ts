/**
 * 缩略图任务调度器（F-01 修复 2026-10-06；事件让位改造 2026-10-07）
 *
 * 单一全局闸门：后台与交互任务共享一个总并发预算，总运行数严格 ≤ concurrency。
 *
 * 为什么从「双 PQueue 互推并发值」改成这个：
 * - 旧实现：后台队列与交互队列各自通过 `Math.max(1, 预算 - 对方 pending)` 推导自己的
 *   concurrency。两个队列都保留「至少 1 个执行位」时，8 个后台运行中 + 1 个交互任务
 *   会同时运行 9 个任务，超过预算（F-01，审查报告 2026-10-06）。
 * - 新实现：单一 PQueue 的 concurrency 固定为预算值，从结构上保证总运行数不可能超限；
 *   交互优先用 p-queue 原生 priority 表达（数字越大越先出队）。
 *
 * 事件让位（2026-10-07，替换原「浏览租约挂起」机制）：
 * - 旧机制：用户浏览时按时间（browseLeaseMs=30s 租约）挂起全部后台任务，另加
 *   backgroundMaxDeferMs=60s 强制放行兜底。问题：增量更新场景（如只新增 1 个文件）
 *   即使没有交互任务、槽位全空闲，后台任务也要白等 30s；60s 兜底在持续浏览时
 *   只保证「入队排队」而非「真正执行」，形同虚设。
 * - 新机制：后台任务始终入队（priority=0），交互任务 priority=10 永远先出队；
 *   PQueue 一次启动 concurrency 个任务时，交互不足则用后台任务填满剩余槽位——
 *   「浏览优先调度 + 后台填满空闲槽位」，零时间参数、零槽位浪费。
 * - 结构性 trade-off：运行中的任务不可被抢占；首次启动大量后台任务占满槽位时，
 *   新到达的交互任务需等运行中的后台任务完成（单任务有 ffmpeg 60s 超时上限，
 *   通常几百 ms），属可接受的短期等待；交互任务一旦开始执行即按 priority 持续占优。
 *
 * 本模块不依赖数据库与缩略图生成（job 由调用方提供），因此可独立单测：
 * 并发不变量 / 交互插队 / 后台填槽 / 积压计数见 thumbnailScheduler.test.ts。
 */
import PQueue from 'p-queue'

/** 构造参数 */
export interface ThumbnailSchedulerOptions {
  /** 总并发预算（后台 + 交互同时运行的任务总数上限） */
  concurrency: number
}

/** 队列指标快照（F-02 诊断用，供 /api/stats 展示） */
export interface ThumbnailQueueMetrics {
  /** 当前正在运行的任务总数（后台 + 交互） */
  running: number
  /** 正在运行的交互任务数（浏览中照片的生成请求） */
  interactiveRunning: number
  /** 排队等待的交互任务数 */
  interactiveWaiting: number
  /** 因客户端断开被跳过的请求累计数（F-02 轻量版计数） */
  cancelled: number
}

/** 任务优先级：交互 = 急诊（插队），后台 = 普通门诊（排队） */
const PRIORITY = {
  interactive: 10,
  background: 0,
} as const

export class ThumbnailScheduler {
  /** 单一执行队列：concurrency 固定，总运行数天然 ≤ 预算 */
  private readonly queue: PQueue

  /** 正在运行的交互任务数（wrapper 执行期计数） */
  private interactiveRunningCount = 0

  /** 排队等待的交互任务数（入队 +1，开始执行 -1） */
  private interactiveWaitingCount = 0

  /** 因客户端断开被跳过（未开始生成）的请求累计数 */
  private cancelledCount = 0

  constructor(options: ThumbnailSchedulerOptions) {
    this.queue = new PQueue({ concurrency: options.concurrency })
  }

  /**
   * 提交一个任务。
   * - interactive：priority 10，先于后台出队（插队）。
   * - background：priority 0，始终入队；交互任务不足时用后台任务填满剩余槽位。
   * 返回的 Promise 在任务真正完成时 resolve / reject。
   */
  submit(job: () => Promise<unknown>, priority: 'interactive' | 'background'): Promise<unknown> {
    // 交互计数：入队（含排队中）即 +1，真正开始执行时 -1 并转计为"运行中"。
    const isInteractive = priority === 'interactive'
    if (isInteractive) this.interactiveWaitingCount++

    const wrapped = async (): Promise<unknown> => {
      if (isInteractive) {
        this.interactiveWaitingCount--
        this.interactiveRunningCount++
      }
      try {
        return await job()
      } finally {
        if (isInteractive) this.interactiveRunningCount--
      }
    }

    return this.queue.add(wrapped, { priority: PRIORITY[priority] })
  }

  /** 当前积压任务数 = 排队中 + 运行中（供 /api/stats 展示） */
  queuedCount(): number {
    return this.queue.size + this.queue.pending
  }

  /** 当前正在运行的任务数（单测断言并发不变量用） */
  get runningCount(): number {
    return this.queue.pending
  }

  /** F-02 轻量版：记录一次因客户端断开被跳过（未开始生成）的请求 */
  registerCancelled(): void {
    this.cancelledCount++
  }

  /** 队列指标快照（运行中 / 交互运行中 / 交互等待 / 已跳过），供 /api/stats 与诊断 */
  metrics(): ThumbnailQueueMetrics {
    return {
      running: this.queue.pending,
      interactiveRunning: this.interactiveRunningCount,
      interactiveWaiting: this.interactiveWaitingCount,
      cancelled: this.cancelledCount,
    }
  }
}
