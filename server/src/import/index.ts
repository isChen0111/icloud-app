/**
 * 导入编排入口（路由层调用）
 *
 * 职责：把「停 watcher → importDirectory 归置 → runScan 落库 → 恢复 watcher」串成一条
 * 后台任务链。导入与 icloud 同步零耦合：不经过 icloudpd/sync.ts，只复用 scanner 落库。
 *
 * 导入期间停 watcher（决策 #9）：归置文件会向 import/ 目录大量写入，若 watcher 开着，
 * 每次写入都会触发防抖扫描，与导入结束后的统一 runScan 互相踩。停掉后统一扫一次即可。
 */
import { importDirectory } from './fsImport.js'
import { importState, isImportBusy, resetImportState } from './state.js'
import { stopWatcher, startWatcher } from '../scanner/watcher.js'
import { runScan, scanProgress } from '../scanner/index.js'
import { libraryImportDir, type LibraryRow } from '../db/libraries.js'
import type { ImportMode, ImportOptions } from './types.js'
import { cleanImportTempDir } from './upload.js'

/** 取消当前导入（若正在跑）。主循环每处理一个资产检查一次状态即退。 */
export function cancelImport(): void {
  if (importState.status === 'running') {
    importState.status = 'cancelled'
    importState.message = '正在取消…'
  }
}

/** 落库目标根（= libraryImportDir(lib.library_root)） */
function targetRootOf(lib: LibraryRow): string {
  return libraryImportDir(lib.library_root)
}

/**
 * 核心流水线：停 watcher → 归置文件 → runScan 落库 → 恢复 watcher。
 * 无论归置成功/失败/取消，都做一次 runScan（把已归置的文件入库），最后恢复 watcher。
 */
async function runImportPipeline(opts: ImportOptions): Promise<void> {
  stopWatcher()
  try {
    await importDirectory(opts)
  } catch (err) {
    // importDirectory 内部已按单文件 try/catch，理论上不抛；这里兜底防整体异常。
    importState.status = 'error'
    importState.message = (err as Error).message
    importState.finishedAt = new Date().toISOString()
    console.error('[import] 导入失败:', err)
  }
  try {
    await runScan('manual')
  } catch (err) {
    scanProgress.status = 'error'
    scanProgress.message = (err as Error).message
    console.error('[import] 落库扫描失败:', err)
  }
  startWatcher()
}

/**
 * 启动「本机迁移」：后端运行机器的本地目录 → 复制/移动进 import/。
 * @returns ok=false 表示已有导入任务在跑（调用方返回 409）
 */
export function startLocalImport(lib: LibraryRow, sourceDir: string, mode: ImportMode): { ok: boolean; message: string } {
  if (isImportBusy()) return { ok: false, message: '已有导入任务执行中，请等待完成或取消' }
  resetImportState()
  importState.status = 'running'
  importState.libraryId = lib.id
  importState.source = 'local'
  importState.mode = mode
  void runImportPipeline({
    libraryId: lib.id,
    sourceDir,
    targetRoot: targetRootOf(lib),
    mode,
    source: 'local',
  })
  return { ok: true, message: '已启动导入' }
}

/**
 * 启动「上传导入」：上传端点已把文件流式写到 tmpDir，这里把它当成本机目录走同一条流水线
 * （mode='move'：从临时目录 move 进 import/，省空间），结束后清理临时目录。
 */
export function startUploadImport(lib: LibraryRow, tmpDir: string): { ok: boolean; message: string } {
  if (isImportBusy()) return { ok: false, message: '已有导入任务执行中，请等待完成或取消' }
  resetImportState()
  importState.status = 'running'
  importState.libraryId = lib.id
  importState.source = 'upload'
  importState.mode = 'move'
  void (async () => {
    try {
      await runImportPipeline({
        libraryId: lib.id,
        sourceDir: tmpDir,
        targetRoot: targetRootOf(lib),
        mode: 'move',
        source: 'upload',
      })
    } finally {
      // 无论成功/失败/取消，临时目录都要清理（文件已 move 走，残留用 force 删）
      await cleanImportTempDir(tmpDir)
    }
  })()
  return { ok: true, message: '已启动导入' }
}
