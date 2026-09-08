/**
 * 任务队列（p-queue）
 *
 * 缩略图生成是 CPU/IO 混合任务，必须限制并发，否则会把磁盘/CPU 打满。
 * - 并发 4：既保证速度又留足余量给 API 响应。
 * - 同一资产重复入队：用 Set 去重（懒生成 + 滚动浏览时同一张图可能被反复请求）。
 */
import PQueue from 'p-queue'
import { config } from '../config.js'
import { ensureThumbnail } from './thumbnails.js'

const queue = new PQueue({ concurrency: config.thumbConcurrency })
const queued = new Set<string>() // 去重键：`${id}:${size}`

/** 入队参数 */
export interface EnqueueItem {
  id: number
  relPath: string
  type: 'photo' | 'video' | 'live'
  liveVideo: string | null
}

/**
 * 提交一个资产的全部网格档缩略图任务（grid + blur）。
 * 调用方可并发触发多次，内部自动去重。
 */
export function enqueueAsset(item: EnqueueItem): void {
  for (const size of ['grid', 'blur'] as const) {
    const key = `${item.id}:${size}`
    if (queued.has(key)) continue
    queued.add(key)
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    queue.add(() =>
      ensureThumbnail(item.id, size).finally(() => queued.delete(key)),
    )
  }
}

/** 队列当前积压数量（供 /api/stats 展示） */
export function queueSize(): number {
  return queue.size + queue.pending
}
