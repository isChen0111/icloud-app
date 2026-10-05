/**
 * 任务队列（p-queue）
 *
 * 缩略图生成是 CPU/IO 混合任务，必须限制并发，否则会把磁盘/CPU 打满。
 * - 并发数由 config.thumbConcurrency 控制，给 API 响应留出余量。
 * - 同一资产重复入队：用 Set 去重（懒生成 + 滚动浏览时同一张图可能被反复请求）。
 */
import PQueue from 'p-queue'
import { config } from '../config.js'
import { ensureThumbnail } from './thumbnails.js'

const queue = new PQueue({ concurrency: config.thumbConcurrency })
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

/**
 * 提交一个资产的网格缩略图任务。
 * 调用方可并发触发多次，内部自动去重。
 */
export function enqueueAsset(item: EnqueueItem): void {
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
  queue.add(() =>
    ensureThumbnail(item.id, size)
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
  return queue.size + queue.pending
}
