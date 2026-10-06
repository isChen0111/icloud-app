/**
 * 缩略图任务调度器（F-01 修复，2026-10-06）
 *
 * 单一全局闸门：后台与交互任务共享一个总并发预算，总运行数严格 ≤ concurrency。
 *
 * 为什么从「双 PQueue 互推并发值」改成这个：
 * - 旧实现：后台队列与交互队列各自通过 `Math.max(1, 预算 - 对方 pending)` 推导自己的
 *   concurrency。两个队列都保留「至少 1 个执行位」时，8 个后台运行中 + 1 个交互任务
 *   会同时运行 9 个任务，超过预算（F-01，审查报告 2026-10-06）。
 * - 新实现：单一 PQueue 的 concurrency 固定为预算值，从结构上保证总运行数不可能超限；
 *   交互优先改用 p-queue 原生 priority 表达（数字越大越先出队），
 *   浏览活动时后台任务挂起（不派发），交互独占全部槽位。
 *
 * 本模块不依赖数据库与缩略图生成（job 由调用方提供），因此可独立单测：
 * 并发不变量 / 交互插队 / 浏览租约 / 积压计数见 thumbnailScheduler.test.ts。
 */
import PQueue from 'p-queue'

/** 构造参数 */
export interface ThumbnailSchedulerOptions {
  /** 总并发预算（后台 + 交互同时运行的任务总数上限） */
  concurrency: number
  /** 浏览租约时长（ms）：最后一次浏览活动后多久恢复后台补图 */
  browseLeaseMs: number
}

/** 任务优先级：交互 = 急诊（插队），后台 = 普通门诊（排队） */
const PRIORITY = {
  interactive: 10,
  background: 0,
} as const

export class ThumbnailScheduler {
  /** 单一执行队列：concurrency 固定，总运行数天然 ≤ 预算 */
  private readonly queue: PQueue

  private readonly browseLeaseMs: number

  /** 浏览租约到期时间戳：此时间之前后台任务挂起不派发 */
  private browsingUntil = 0

  /** 恢复放行定时器（unref：不阻止进程退出） */
  private resumeTimer: NodeJS.Timeout | undefined

  /** 浏览期间挂起的后台任务：租约到期时统一放行入队 */
  private deferred: (() => void)[] = []

  constructor(options: ThumbnailSchedulerOptions) {
    this.browseLeaseMs = options.browseLeaseMs
    this.queue = new PQueue({ concurrency: options.concurrency })
  }

  /**
   * 提交一个任务。
   * - interactive：直接入队（priority 高，插队先执行），并刷新浏览租约。
   * - background：浏览租约未到期时挂起，到期后放行入队；到期则直接入队。
   * 返回的 Promise 在任务真正完成时 resolve / reject（挂起任务会等到放行后执行）。
   */
  submit(job: () => Promise<unknown>, priority: 'interactive' | 'background'): Promise<unknown> {
    if (priority === 'background' && Date.now() < this.browsingUntil) {
      // 浏览活跃：挂起，租约到期后放行
      return new Promise((resolve, reject) => {
        this.deferred.push(() => {
          this.queue.add(job, { priority: PRIORITY.background }).then(resolve, reject)
        })
      })
    }
    return this.queue.add(job, { priority: PRIORITY[priority] })
  }

  /** 标记浏览活动：刷新租约；租约内后台任务挂起，交互任务不受影响。 */
  markBrowsing(leaseMs = this.browseLeaseMs): void {
    this.browsingUntil = Date.now() + leaseMs
    if (this.resumeTimer) clearTimeout(this.resumeTimer)
    this.scheduleResume()
  }

  /** 租约到期 → 放行挂起的后台任务 */
  private scheduleResume(): void {
    const remaining = this.browsingUntil - Date.now()
    if (remaining <= 0) {
      this.resumeTimer = undefined
      this.flushDeferred()
      return
    }
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = undefined
      this.scheduleResume()
    }, remaining)
    this.resumeTimer.unref()
  }

  private flushDeferred(): void {
    const pending = this.deferred
    this.deferred = []
    for (const run of pending) run()
  }

  /** 当前积压任务数 = 排队中 + 运行中 + 浏览挂起中（供 /api/stats 展示） */
  queuedCount(): number {
    return this.queue.size + this.queue.pending + this.deferred.length
  }

  /** 当前正在运行的任务数（单测断言并发不变量用） */
  get runningCount(): number {
    return this.queue.pending
  }
}
