/**
 * 导入任务状态机（仿 scanner 的 scanProgress / icloudpd 的 syncState）
 *
 * 全局单例：导入与扫描/同步一样是「全局单任务」，一次只允许一个导入在跑。
 * 状态在内存里，服务重启即清空（与 syncState 一致，不落 meta.db）。
 *
 * ## 运行令牌与取消信号（审查 C-01 修复，2026-11-02）
 *
 * 旧实现的取消**只是一次 status 赋值**（`status='cancelled'`），由此派生出两个漏洞：
 *   ① 主循环的 `isCancelled()` 读的也是 `status`，新任务 `resetImportState()` 把它改回
 *      `'running'` 后，旧主循环下一次检查就返回 false —— **取消等于没取消**，两条流水线
 *      同时往同一目录 `cp`；
 *   ② 旧主循环结束时无条件写终态，会把新任务的 `done/finishedAt` 冲掉。
 *
 * 现在改成两个独立的量：
 *   - `runToken`：每次启动 +1。流水线持有自己的令牌，**任何状态写回前都要校验令牌未变**，
 *     被新任务接管后一律不写（终态、进度都不写）。
 *   - `cancelRequested`：取消只置这个布尔 + 改文案，**不碰 status**。主循环据此退出循环，
 *     再由持有令牌的流水线自己写 `cancelled` 终态。
 *
 * `isImportBusy()` 覆盖「已请求取消、流水线尚未收尾」这段过渡期（`cancelled` 且
 * `finishedAt == null`）：这期间文件还在拷、watcher 还没恢复，既不能开新导入，
 * 也不能切库/删库。这段语义前端 ImportDialog / tasks store 已经在用。
 */
import type { ImportProgress } from './types.js'

export const importState: ImportProgress = {
  status: 'idle',
  phase: 'idle',
  libraryId: 0,
  source: 'local',
  mode: 'copy',
  message: '',
  totalFiles: 0,
  processedFiles: 0,
  skipped: 0,
  exifPatched: 0,
  exifSkipped: 0,
  exifFailed: 0,
  exifMtimeFailed: 0,
  failedCount: 0,
  failures: [],
  cancelRequested: false,
  startedAt: null,
  finishedAt: null,
}

/** 当前运行令牌（每次 start*Import +1） */
let runToken = 0
/** 当前运行是否已收到取消请求 */
let cancelRequested = false

/** 复位为初始状态（每次导入开始前调用；不动令牌，令牌由 beginImportRun 负责） */
export function resetImportState(): void {
  importState.status = 'idle'
  importState.phase = 'idle'
  importState.libraryId = 0
  importState.source = 'local'
  importState.mode = 'copy'
  importState.message = ''
  importState.totalFiles = 0
  importState.processedFiles = 0
  importState.skipped = 0
  importState.exifPatched = 0
  importState.exifSkipped = 0
  importState.exifFailed = 0
  importState.exifMtimeFailed = 0
  importState.failedCount = 0
  importState.failures = []
  importState.cancelRequested = false
  importState.startedAt = null
  importState.finishedAt = null
}

/**
 * 开启一次新的运行：令牌 +1、清掉上一次的取消请求，返回本次令牌。
 * 调用方必须把返回的令牌一路传给流水线，流水线内所有状态写回都以它为准。
 */
export function beginImportRun(): number {
  runToken += 1
  cancelRequested = false
  return runToken
}

/** 当前令牌（流水线用它判断自己是否已被新任务接管） */
export function currentImportToken(): number {
  return runToken
}

/** 本次运行是否已被取消（只看自己的信号，不看 status —— 见文件头注释） */
export function isImportCancelRequested(): boolean {
  return cancelRequested
}

/**
 * 请求取消当前导入。只置信号，不改 status：终态由持有令牌的流水线在真正退出时写。
 *
 * **扫描阶段不受理取消**（审查 C-06）：此时文件已全部归置完毕，只剩 runScan 落库，
 * 中途退出只会留下一半入库的照片。若受理会把 cancelRequested 置真，流水线收尾时
 * 反而把一个已经成功的导入写成 `cancelled`。前端在 phase==='scanning' 时也不显示取消按钮。
 *
 * @returns 是否受理（没有在跑的任务、或已进入落库阶段，返回 false）
 */
export function requestImportCancel(): boolean {
  if (!isImportBusy()) return false
  if (importState.phase === 'scanning') return false
  if (importState.status === 'running' && !cancelRequested) {
    cancelRequested = true
    importState.cancelRequested = true
    importState.message = '正在取消…'
  }
  return true
}

/**
 * 是否有一个导入任务「占据着」库（用于路由守卫与 libraryBusyGuard）。
 *
 * 含过渡期：已请求取消但流水线还没收尾（`cancelled` 且 `finishedAt == null`）。
 * 这段期间文件仍在往库里拷、watcher 仍处于关闭状态，开新导入会双写、切库会写错库。
 */
export function isImportBusy(): boolean {
  return (
    importState.status === 'running' ||
    (importState.status === 'cancelled' && importState.finishedAt == null)
  )
}

/** 对外暴露的进度快照（截断失败清单，避免大目录失败项过多撑大响应体） */
export function publicImportState(): ImportProgress {
  return { ...importState, failures: importState.failures.slice(-200) }
}
