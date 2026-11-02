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
import { importDirectory } from './fsImport.js'
import {
  importState,
  isImportBusy,
  resetImportState,
  beginImportRun,
  currentImportToken,
  requestImportCancel,
} from './state.js'
import { stopWatcher, startWatcher } from '../scanner/watcher.js'
import { runScan, scanProgress } from '../scanner/index.js'
import { libraryImportDir, type LibraryRow } from '../db/libraries.js'
import type { ImportMode, ImportOptions } from './types.js'
import { cleanImportTempDir } from './upload.js'

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
 */
async function runImportPipeline(opts: ImportOptions, token: number): Promise<void> {
  /** 是否仍持有令牌（被新任务接管后，收尾动作一律交给新任务） */
  const owns = (): boolean => token === currentImportToken()

  try {
    stopWatcher()
    try {
      await importDirectory(opts, token)
    } catch (err) {
      // importDirectory 内部已按单文件 try/catch，理论上不抛；这里兜底防整体异常。
      if (owns()) {
        importState.status = 'error'
        importState.message = (err as Error).message
        importState.finishedAt = new Date().toISOString()
      }
      console.error('[import] 导入失败:', err)
    } finally {
      // 兜底：任何异常路径都不能让 finishedAt 空着。否则「已取消但未收尾」会永久占住
      // isImportBusy()，导入与切库/删库全部被卡死，只能重启服务。
      if (owns() && importState.finishedAt == null && importState.status !== 'running') {
        importState.finishedAt = new Date().toISOString()
      }
    }

    // 已被新任务接管：落库扫描也归新任务负责（它结束时自己会扫一次）
    if (!owns()) return

    try {
      await runScan('manual')
    } catch (err) {
      scanProgress.status = 'error'
      scanProgress.message = (err as Error).message
      console.error('[import] 落库扫描失败:', err)
    }
  } finally {
    // watcher 恢复放 finally：停 watcher 本身抛错（或被接管）时也不能把库永久置于
    // 「无监听」状态，否则此后新增文件只能靠手动扫描才发现。
    // 被接管时不恢复——新任务启动时已 stopWatcher，它自己收尾时再恢复。
    if (owns()) startWatcher()
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
 */
export function startUploadImport(lib: LibraryRow, tmpDir: string): { ok: boolean; message: string } {
  if (isImportBusy()) return { ok: false, message: '已有导入任务执行中，请等待完成或取消' }
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
