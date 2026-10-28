/**
 * 任务队列（单一调度器，F-01 修复 2026-10-06；事件让位改造 2026-10-07）
 *
 * 后台和交互任务共享一个总并发预算：
 * - 单一 PQueue 的 concurrency 固定 = thumbConcurrency，总运行数严格 ≤ 预算
 *   （旧实现用双队列互推并发值，8 后台运行中 + 1 交互会产生 9 个并发，见审查报告 F-01）。
 * - 交互优先由调度器 priority 表达（交互 10 / 后台 0，排队时插队）；后台任务始终入队，
 *   交互任务不足时用后台填满剩余槽位（事件让位：零时间参数、零槽位浪费，见 thumbnailScheduler）。
 * - 同一资产重复入队：用 Set 去重（懒生成 + 滚动浏览时同一张图可能被反复请求）。
 *
 * 对外接口（enqueueAsset / runInteractiveThumbnail / beginThumbnailBatch /
 * resetThumbnailProgress / getThumbnailProgress / queueSize）保持不变，
 * 调用方（thumb.ts / scanner / stats.ts / thumbnail-errors.ts）无需改动。
 * 调度核心见 thumbnailScheduler.ts（纯逻辑、可单测）。
 */
import { config } from '../config.js'
import { getDb } from '../db/index.js'
import { ensureThumbnail } from './thumbnails.js'
import { ThumbnailScheduler, type ThumbnailQueueMetrics } from './thumbnailScheduler.js'

/** 交互与后台共享的调度器：总并发 = config.thumbConcurrency */
const scheduler = new ThumbnailScheduler({
  concurrency: config.thumbConcurrency,
})

const queued = new Map<string, Set<number>>() // 去重键 → 等待该任务结果的批次

/**
 * 队列世代（R-06 修复，2026-10-28）。
 *
 * 切库时不再清空 p-queue 的排队任务（`clear()` 会丢弃任务并让它们的 Promise 永不 settle，
 * 表现为 /api/thumb 请求挂死、占满浏览器同域连接）。改为把世代 +1：
 * 旧任务仍留在队列里，但轮到执行时发现世代不符就直接返回，Promise 正常结束。
 * 代价是这些任务会「空转」一遍，单个只花几微秒。
 */
let queueGeneration = 0

export interface ThumbnailProgress {
  status: 'idle' | 'preparing' | 'done'
  total: number
  processed: number
  completed: number
  pending: number
  failed: number
}

let thumbnailProgress: ThumbnailProgress = {
  status: 'idle',
  total: 0,
  processed: 0,
  completed: 0,
  pending: 0,
  failed: 0,
}
let thumbnailBatchId = 0

/** 入队参数 */
export interface EnqueueItem {
  id: number
  type: 'photo' | 'video' | 'live'
}

/** 从持久化资产状态初始化累计进度；重启服务不会丢失已生成数量。 */
export function beginThumbnailBatch(): void {
  thumbnailBatchId++
  // 关键（2026-10-07 体检修复）：把当前在途任务「过继」到新批次。
  // 任务入队时关联的是当时的批次号，重建账本后它们手里还是旧号，完成时
  // recordThumbnailResult 对不上新 batchId 会被整批丢弃 → 新批次 pending
  // 永不减少、进度条卡死（卡死数 = 重建账本时的在途任务数，不会自愈）。
  // 场景：后台任务在跑时用户对失败项点「忽略/重试」（本函数被调用）。
  for (const batches of queued.values()) batches.add(thumbnailBatchId)
  const counts = getDb()
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN thumb_status = 'done' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN thumb_status = 'pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN thumb_status = 'error' THEN 1 ELSE 0 END) AS allFailed,
              SUM(CASE WHEN thumb_status = 'error' AND thumb_ignored = 0 THEN 1 ELSE 0 END) AS failed
       FROM assets`,
    )
    .get() as {
      total: number
      completed: number | null
      pending: number | null
      allFailed: number | null
      failed: number | null
    }
  const completed = counts.completed ?? 0
  const pending = counts.pending ?? 0
  thumbnailProgress = {
    status: pending > 0 ? 'preparing' : 'done',
    total: counts.total,
    processed: completed + (counts.allFailed ?? 0),
    completed,
    pending,
    failed: counts.failed ?? 0,
  }
}

/** 新一轮扫描开始时隐藏上一轮的任务进度，直到本轮待处理总量确定。 */
export function resetThumbnailProgress(): void {
  thumbnailBatchId++
  thumbnailProgress = {
    status: 'idle',
    total: 0,
    processed: 0,
    completed: 0,
    pending: 0,
    failed: 0,
  }
}

export function getThumbnailProgress(): ThumbnailProgress {
  return { ...thumbnailProgress }
}

/** 将直接由浏览页面触发的任务放入共享队列，并优先于剩余后台任务执行。 */
export function runInteractiveThumbnail<T>(task: () => Promise<T>): Promise<T | null> {
  const gen = queueGeneration
  let result: T | null = null
  return scheduler
    .submit(async () => {
      // R-06：切库换代后，旧库排队中的交互任务直接空转（不再拿旧 id 去查新库），
      // Promise 正常 resolve 成 null，请求不会挂死。调用方（thumb.ts）已按 falsy 处理。
      if (gen !== queueGeneration) return
      result = await task()
    }, 'interactive')
    .then(() => result)
}

/**
 * 提交一个资产的网格缩略图任务。
 * 调用方可并发触发多次，内部自动去重（同一 key 只入队一次）。
 */
export function enqueueAsset(item: EnqueueItem, priority: 'background' | 'user' = 'background'): void {
  const size = 'grid'
  const key = `${item.id}:${size}`
  const batchId = thumbnailBatchId
  const existingBatches = queued.get(key)
  if (existingBatches) {
    if (thumbnailProgress.status === 'preparing') existingBatches.add(batchId)
    return
  }
  const batches = new Set<number>()
  if (thumbnailProgress.status === 'preparing') batches.add(batchId)
  queued.set(key, batches)

  const gen = queueGeneration
  const job = () => {
    // R-06：切库换代后，旧库的排队任务不再真正生成（否则会用旧 id 去新库里找图）
    if (gen !== queueGeneration) return Promise.resolve()
    return ensureThumbnail(item.id, size, priority === 'background' ? 'background' : 'interactive')
      .then((result) => {
        for (const id of batches) recordThumbnailResult(id, result !== null)
      })
      .catch((error: unknown) => {
        // R-05 修复（2026-10-28）：这里不再 `throw`。
        // 结果已经记录，再抛出去只会变成「无人处理的 Promise 拒绝」——
        // Node 15+ 默认把 unhandledRejection 当作未捕获异常直接终止进程，
        // 即一张缩略图生成失败就足以让整个后端退出。错误就此打住，只写日志。
        for (const id of batches) recordThumbnailResult(id, false)
        console.error(`[thumb] 生成失败 asset=${item.id} size=${size}:`, error)
      })
      .finally(() => queued.delete(key))
  }
  // 不 await：任务完成通过 batch 记录/缓存就绪反馈，调用方不需要本任务的 Promise。
  // 末尾的 catch 是双保险：即使 job 内部还有未预料到的抛出，也不会升级成 unhandledRejection。
  void scheduler
    .submit(job, priority === 'user' ? 'interactive' : 'background')
    .catch((error: unknown) => {
      console.error(`[thumb] 队列任务异常 asset=${item.id} size=${size}:`, error)
    })
}

function recordThumbnailResult(batchId: number, succeeded: boolean): void {
  if (batchId !== thumbnailBatchId || thumbnailProgress.status !== 'preparing') return
  thumbnailProgress.processed++
  thumbnailProgress.pending--
  if (succeeded) thumbnailProgress.completed++
  else thumbnailProgress.failed++
  if (thumbnailProgress.pending === 0) thumbnailProgress.status = 'done'
}

/** 队列当前积压数量（供 /api/stats 展示）：排队 + 运行 + 浏览挂起 */
export function queueSize(): number {
  return scheduler.queuedCount()
}

/**
 * 等待缩略图队列彻底空闲（R-20）。
 * 命令行扫描跑完若直接 process.exit，正在写的任务会被切断；
 * cli-scan 在退出前 await 本函数（--no-thumbs 时不入队，也就无需等待）。
 */
export function waitForThumbnailIdle(): Promise<void> {
  return scheduler.onIdle()
}

/** 队列指标快照（运行中 / 交互运行中 / 交互等待 / 已跳过），供 /api/stats 展示 */
export function getQueueMetrics(): ThumbnailQueueMetrics {
  return scheduler.metrics()
}

/** F-02 轻量版：记录一次因客户端断开被跳过（未开始生成）的缩略图请求 */
export function registerThumbnailCancelled(): void {
  scheduler.registerCancelled()
}

/**
 * 切库时作废旧库的缩略图任务（R-06 修复，2026-10-28）：
 * 世代 +1 → 排队中的旧库任务轮到执行时直接空转退出，Promise 正常 settle（不再悬挂）；
 * 正在运行的旧库任务继续跑完（ensureThumbnail 内部按当前 getDb 查行，切库后旧 id 查不到即跳过，无害）。
 * 进度账本复位，避免旧库进度串到新库。
 */
export function clearThumbnailQueue(): void {
  queueGeneration++
  queued.clear()
  scheduler.resetCounters()
  resetThumbnailProgress()
}
