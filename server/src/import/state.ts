/**
 * 导入任务状态机（仿 scanner 的 scanProgress / icloudpd 的 syncState）
 *
 * 全局单例：导入与扫描/同步一样是「全局单任务」，一次只允许一个导入在跑。
 * 状态在内存里，服务重启即清空（与 syncState 一致，不落 meta.db）。
 */
import type { ImportProgress } from './types.js'

export const importState: ImportProgress = {
  status: 'idle',
  libraryId: 0,
  source: 'local',
  mode: 'copy',
  message: '',
  totalFiles: 0,
  processedFiles: 0,
  skipped: 0,
  failedCount: 0,
  failures: [],
  startedAt: null,
  finishedAt: null,
}

/** 复位为初始状态（每次导入开始前调用） */
export function resetImportState(): void {
  importState.status = 'idle'
  importState.libraryId = 0
  importState.source = 'local'
  importState.mode = 'copy'
  importState.message = ''
  importState.totalFiles = 0
  importState.processedFiles = 0
  importState.skipped = 0
  importState.failedCount = 0
  importState.failures = []
  importState.startedAt = null
  importState.finishedAt = null
}

/** 是否有一个导入任务正在执行（用于路由守卫与 libraryBusyGuard） */
export function isImportBusy(): boolean {
  return importState.status === 'running'
}

/** 对外暴露的进度快照（截断失败清单，避免大目录失败项过多撑大响应体） */
export function publicImportState(): ImportProgress {
  return { ...importState, failures: importState.failures.slice(-200) }
}
