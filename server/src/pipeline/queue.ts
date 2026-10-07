/**
 * 任务队列（单一调度器，F-01 修复 2026-10-06）
 *
 * 后台和交互任务共享一个总并发预算：
 * - 单一 PQueue 的 concurrency 固定 = thumbConcurrency，总运行数严格 ≤ 预算
 *   （旧实现用双队列互推并发值，8 后台运行中 + 1 交互会产生 9 个并发，见审查报告 F-01）。
 * - 交互优先由调度器 priority 表达（交互 10 / 后台 0，排队时插队）。
 * - 浏览活动租约：用户浏览时后台任务挂起不派发（交互独占全部槽位）；
 *   停止活动 30 秒后后台补图恢复。已运行的任务不强制中断。
 * - 同一资产重复入队：用 Set 去重（懒生成 + 滚动浏览时同一张图可能被反复请求）。
 *
 * 对外接口（enqueueAsset / runInteractiveThumbnail / markThumbnailBrowsing /
 * beginThumbnailBatch / resetThumbnailProgress / getThumbnailProgress / queueSize）
 * 保持不变，调用方（thumb.ts / scanner / stats.ts / thumbnail-errors.ts）无需改动。
 * 调度核心见 thumbnailScheduler.ts（纯逻辑、可单测）。
 */
import { config } from '../config.js'
import { getDb } from '../db/index.js'
import { ensureThumbnail } from './thumbnails.js'
import { ThumbnailScheduler, type ThumbnailQueueMetrics } from './thumbnailScheduler.js'

/** 交互与后台共享的调度器：总并发 = config.thumbConcurrency，浏览租约 30 秒，后台挂起上限 60 秒（防饿死） */
const scheduler = new ThumbnailScheduler({
  concurrency: config.thumbConcurrency,
  browseLeaseMs: 30_000,
  backgroundMaxDeferMs: 60_000,
})

const queued = new Map<string, Set<number>>() // 去重键 → 等待该任务结果的批次

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
  relPath: string
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

/** 用户有浏览交互时暂停后台补图；当前任务完成后不再启动新的后台任务。 */
export function markThumbnailBrowsing(leaseMs = 30_000): void {
  scheduler.markBrowsing(leaseMs)
}

/** 将直接由浏览页面触发的任务放入共享队列，并优先于剩余后台任务执行。 */
export function runInteractiveThumbnail<T>(task: () => Promise<T>): Promise<T> {
  markThumbnailBrowsing()
  let result: T
  return scheduler
    .submit(async () => {
      result = await task()
    }, 'interactive')
    .then(() => result)
}

/**
 * 提交一个资产的网格缩略图任务。
 * 调用方可并发触发多次，内部自动去重（同一 key 只入队一次）。
 */
export function enqueueAsset(item: EnqueueItem, priority: 'background' | 'user' = 'background'): void {
  if (priority === 'user') markThumbnailBrowsing()
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

  const job = () =>
    ensureThumbnail(item.id, size, priority === 'background' ? 'background' : 'interactive')
      .then((result) => {
        for (const id of batches) recordThumbnailResult(id, result !== null)
      })
      .catch((error: unknown) => {
        for (const id of batches) recordThumbnailResult(id, false)
        throw error
      })
      .finally(() => queued.delete(key))
  // 不 await：任务完成通过 batch 记录/缓存就绪反馈，调用方不需要本任务的 Promise。
  void scheduler.submit(job, priority === 'user' ? 'interactive' : 'background')
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

/** 队列指标快照（运行中 / 交互运行中 / 交互等待 / 已跳过），供 /api/stats 展示 */
export function getQueueMetrics(): ThumbnailQueueMetrics {
  return scheduler.metrics()
}

/** F-02 轻量版：记录一次因客户端断开被跳过（未开始生成）的缩略图请求 */
export function registerThumbnailCancelled(): void {
  scheduler.registerCancelled()
}
