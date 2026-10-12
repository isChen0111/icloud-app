/**
 * icloudpd 同步任务状态（内存单例，随服务重启清空）
 *
 * 前端轮询 /api/stats 或 /api/library/:id/sync 获取；进程是黑盒，进度以
 * 输出行（Downloading… / Downloaded…）计数估算，不解析 Apple 侧精确条目数。
 */
export interface SyncTaskState {
  /** idle=无任务 | running=执行中 | waiting_retry=等待重试 | error | cancelled | done */
  status: 'idle' | 'running' | 'waiting_retry' | 'error' | 'cancelled' | 'done'
  libraryId: number
  kind: 'full' | 'inc'
  message: string
  /** 已完成的下载条目数（输出行计数，近似） */
  downloaded: number
  startedAt: string | null
  finishedAt: string | null
  pid: number | null
}

export const syncState: SyncTaskState = {
  status: 'idle',
  libraryId: 0,
  kind: 'full',
  message: '',
  downloaded: 0,
  startedAt: null,
  finishedAt: null,
  pid: null,
}

/** 复位为 idle（取消/完成后） */
export function resetSyncState(): void {
  syncState.status = 'idle'
  syncState.libraryId = 0
  syncState.message = ''
  syncState.downloaded = 0
  syncState.startedAt = null
  syncState.finishedAt = null
  syncState.pid = null
}
