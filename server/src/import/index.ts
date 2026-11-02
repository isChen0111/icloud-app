/**
 * 导入编排入口（路由层调用）
 *
 * 职责：把「停 watcher → importDirectory 归置 → runScan 落库 → 恢复 watcher」串成一条
 * 后台任务链。与 icloud 同步**单向**解耦：导入不经过 icloudpd/sync.ts，只复用 scanner 落库；
 * 但反向不互斥——同步可以在导入进行中启动（审查 C-05/P2-12，尚未修）。
 *
 * 导入期间停 watcher（决策 #9）：归置文件会向 import/ 目录大量写入，若 watcher 开着，
 * 每次写入都会触发防抖扫描，与导入结束后的统一 runScan 互相踩。停掉后统一扫一次即可。
 *
 * 运行令牌（审查 C-01）：每次启动分配一个令牌，流水线内部的进度/终态写回都以它为准。
 * 本文件的收尾动作（runScan / 恢复 watcher）同样校验令牌——若已被新任务接管，
 * 这些动作必须交给新任务，否则旧任务会在新导入进行中把 watcher 拉起来。
 */
import { importDirectory, cleanupPartFiles, type ImportRunResult } from './fsImport.js'
import {
  importState,
  isImportBusy,
  resetImportState,
  beginImportRun,
  currentImportToken,
  requestImportCancel,
} from './state.js'
import { stopWatcher, startWatcher } from '../scanner/watcher.js'
import { runScan } from '../scanner/index.js'
import { libraryImportDir, type LibraryRow } from '../db/libraries.js'
import type { ImportFailure, ImportMode, ImportOptions } from './types.js'
import { cleanImportTempDir } from './upload.js'
import { getCurrentLibrary } from '../context.js'

/**
 * 请求取消当前导入。只置取消信号，**不改 status**：终态由持有令牌的流水线在真正退出时写。
 * 旧实现直接把 status 改成 'cancelled'，等于取消信号和终态用同一个字段——新任务把 status
 * 改回 'running' 后，旧主循环的取消检查随即失效，两条流水线同时写同一目录（C-01）。
 * @returns 是否受理（没有在跑的任务返回 false）
 */
export function cancelImport(): boolean {
  return requestImportCancel()
}

/** 落库目标根（= libraryImportDir(lib.library_root)） */
function targetRootOf(lib: LibraryRow): string {
  return libraryImportDir(lib.library_root)
}

/**
 * 核心流水线：停 watcher → 归置文件 → runScan 落库 → 恢复 watcher。
 * 无论归置成功/失败/取消，都做一次 runScan（把已归置的文件入库），最后恢复 watcher。
 *
 * 终态归属（审查 C-06）：`status`/`finishedAt` 一律在这里、**在 runScan 之后**才写。
 * 归置结束就报「导入完成」是假完成——照片盘上有了、库里还没有，前端一刷新就是空墙。
 * 中间这段用 `phase='scanning'` + 文案说明，前端据此继续轮询、隐藏取消按钮。
 */
async function runImportPipeline(opts: ImportOptions, token: number): Promise<void> {
  /** 是否仍持有令牌（被新任务接管后，收尾动作一律交给新任务） */
  const owns = (): boolean => token === currentImportToken()
  /** 归置阶段是否已经失败（失败终态优先，不被后面的扫描结果覆盖） */
  let copyFailed = false
  /** 归置阶段的结果（cancelled + 终态文案），由下方统一写入 status */
  let pendingResult: ImportRunResult = { cancelled: false, message: '' }

  try {
    stopWatcher()
    try {
      // 清理上次中断残留的 .part（C-09 的原子写会留下残体）
      await cleanupPartFiles(opts.targetRoot)
      const result = await importDirectory(opts, token)
      if (!owns()) return
      // 阶段推进交给下方统一处理
      pendingResult = result
    } catch (err) {
      // importDirectory 内部已按单文件 try/catch，理论上不抛；这里兜底防整体异常。
      copyFailed = true
      if (owns()) {
        importState.status = 'error'
        importState.message = (err as Error).message
      }
      console.error('[import] 导入失败:', err)
    }
    // 已被新任务接管：落库扫描也归新任务负责（它结束时自己会扫一次）
    if (!owns()) return

    // ② 落库阶段：不可取消（文件已归置完，中途退只会留一半入库的照片）
    importState.phase = 'scanning'
    importState.message = copyFailed
      ? '正在整理已导入的照片…'
      : pendingResult.cancelled
        ? '已取消，正在整理已取消前导入的照片…'
        : '正在入库…'
    let scanError: Error | null = null
    try {
      // runScan 与其他扫描源串行（C-05），这里排队等前一轮结束即可
      await runScan('manual')
    } catch (err) {
      scanError = err as Error
      console.error('[import] 落库扫描失败:', err)
    }
    if (!owns()) return

    // ③ 终态：落库真的结束了才写。归置阶段已失败时保留它的错误文案，不覆盖。
    if (!copyFailed) {
      if (scanError) {
        // 文件已归置但没入库 —— 对用户来说仍然是失败，据实报告
        importState.status = 'error'
        importState.message = `照片已导入，但入库扫描失败：${scanError.message}`
      } else {
        importState.status = pendingResult.cancelled ? 'cancelled' : 'done'
        importState.message = pendingResult.message
      }
    }
  } finally {
    // watcher 恢复放 finally：停 watcher 本身抛错（或被接管）时也不能把库永久置于
    // 「无监听」状态，否则此后新增文件只能靠手动扫描才发现。
    // 被接管时不恢复——新任务启动时已 stopWatcher，它自己收尾时再恢复。
    if (owns()) {
      // 兜底：任何异常路径都不能让 finishedAt 空着。否则「已取消但未收尾」会永久占住
      // isImportBusy()，导入与切库/删库全部被卡死，只能重启服务。
      if (importState.finishedAt == null) importState.finishedAt = new Date().toISOString()
      importState.phase = 'idle'
      startWatcher()
    }
  }
}

/**
 * 启动「本机迁移」：后端运行机器的本地目录 → 复制/移动进 import/。
 * @returns ok=false 表示已有导入任务在跑（调用方返回 409）
 */
export function startLocalImport(lib: LibraryRow, sourceDir: string, mode: ImportMode): { ok: boolean; message: string } {
  if (isImportBusy()) return { ok: false, message: '已有导入任务执行中，请等待完成或取消' }
  resetImportState()
  const token = beginImportRun()
  importState.status = 'running'
  importState.libraryId = lib.id
  importState.source = 'local'
  importState.mode = mode
  void runImportPipeline(
    {
      libraryId: lib.id,
      sourceDir,
      targetRoot: targetRootOf(lib),
      mode,
      source: 'local',
    },
    token,
  )
  return { ok: true, message: '已启动导入' }
}

/**
 * 启动「上传导入」：上传端点已把文件流式写到 tmpDir，这里把它当成本机目录走同一条流水线
 * （mode='move'：从临时目录 move 进 import/，省空间），结束后清理临时目录。
 *
 * 重校验激活库（审查 C-12）：上传可能持续几十分钟，而路由只在请求开始时确认过一次。
 * 期间用户切库的话，文件会按旧库落盘、末尾的 runScan 却扫新库 —— 旧库一个都不入库，
 * 接口照样返回成功。本机迁移没有这个窗口（请求里直接启动，不经过耗时阶段）。
 *
 * @param seedFailures 上传阶段已失败的文件（C-11），并进同一份失败清单
 */
export function startUploadImport(
  lib: LibraryRow,
  tmpDir: string,
  seedFailures: ImportFailure[] = [],
): { ok: boolean; message: string } {
  if (isImportBusy()) return { ok: false, message: '已有导入任务执行中，请等待完成或取消' }
  const current = getCurrentLibrary()
  if (!current || current.id !== lib.id) {
    return { ok: false, message: '上传期间切换了照片库，请回到该库重新上传' }
  }
  resetImportState()
  const token = beginImportRun()
  importState.status = 'running'
  importState.libraryId = lib.id
  importState.source = 'upload'
  importState.mode = 'move'
  void (async () => {
    try {
      await runImportPipeline(
        {
          libraryId: lib.id,
          sourceDir: tmpDir,
          targetRoot: targetRootOf(lib),
          mode: 'move',
          source: 'upload',
          seedFailures,
        },
        token,
      )
    } finally {
      // 无论成功/失败/取消，临时目录都要清理（文件已 move 走，残留用 force 删）
      await cleanImportTempDir(tmpDir)
    }
  })()
  return { ok: true, message: '已启动导入' }
}
