/**
 * 任务队列（p-queue）
 *
 * 缩略图生成是 CPU/IO 混合任务，必须限制并发，避免后台补图影响用户浏览。
 * - 后台补图低并发运行；用户有浏览活动时暂停启动新的后台任务。
 * - 用户当前请求使用独立的有限并发队列，避免网格并发请求打满机器。
 * - 同一资产重复入队：用 Set 去重（懒生成 + 滚动浏览时同一张图可能被反复请求）。
 */
import PQueue from 'p-queue'
import { config } from '../config.js'
import { ensureThumbnail } from './thumbnails.js'

const queue = new PQueue({ concurrency: config.thumbConcurrency })
const interactiveQueue = new PQueue({ concurrency: config.interactiveThumbConcurrency })
const queued = new Map<string, Set<number>>() // 去重键 → 等待该任务结果的批次
const browsingLeaseMs = 30_000
let browsingUntil = 0
let resumeTimer: NodeJS.Timeout | undefined

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
  liveVideo: string | null
}

/** 开始记录本轮扫描后待准备的预览图任务。已有 error 状态计入失败，不自动重试。 */
export function beginThumbnailBatch(pending: number, failed: number): void {
  thumbnailBatchId++
  const total = pending + failed
  thumbnailProgress = {
    status: pending > 0 ? 'preparing' : 'done',
    total,
    processed: failed,
    completed: 0,
    pending,
    failed,
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
export function markThumbnailBrowsing(leaseMs = browsingLeaseMs): void {
  browsingUntil = Date.now() + leaseMs
  queue.pause()
  if (resumeTimer) clearTimeout(resumeTimer)
  scheduleBackgroundResume()
}

function scheduleBackgroundResume(): void {
  const remaining = browsingUntil - Date.now()
  if (remaining <= 0) {
    resumeTimer = undefined
    void queue.start()
    return
  }
  resumeTimer = setTimeout(scheduleBackgroundResume, remaining)
  resumeTimer.unref()
}

/** 将直接由浏览页面触发的缩略图生成限制在两个并发内。 */
export function runInteractiveThumbnail<T>(task: () => Promise<T>): Promise<T> {
  markThumbnailBrowsing()
  let result: T
  return interactiveQueue.add(async () => {
    result = await task()
  }).then(() => result)
}

/**
 * 提交一个资产的网格缩略图任务。
 * 调用方可并发触发多次，内部自动去重。
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
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  const targetQueue = priority === 'user' ? interactiveQueue : queue
  targetQueue.add(() =>
    ensureThumbnail(item.id, size, priority === 'background' ? 'background' : 'interactive')
      .then((result) => {
        for (const id of batches) recordThumbnailResult(id, result !== null)
      })
      .catch((error: unknown) => {
        for (const id of batches) recordThumbnailResult(id, false)
        throw error
      })
      .finally(() => queued.delete(key)),
  )
}

function recordThumbnailResult(batchId: number, succeeded: boolean): void {
  if (batchId !== thumbnailBatchId || thumbnailProgress.status !== 'preparing') return
  thumbnailProgress.processed++
  thumbnailProgress.pending--
  if (succeeded) thumbnailProgress.completed++
  else thumbnailProgress.failed++
  if (thumbnailProgress.pending === 0) thumbnailProgress.status = 'done'
}

/** 队列当前积压数量（供 /api/stats 展示） */
export function queueSize(): number {
  return queue.size + queue.pending + interactiveQueue.size + interactiveQueue.pending
}
