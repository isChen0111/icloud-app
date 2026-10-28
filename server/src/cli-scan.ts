/**
 * CLI 扫描脚本
 *
 * 用法：npm run scan [-- --no-thumbs]
 * 用途：不启动 Web 服务，单独执行一次全量扫描入库（调试 / 预热用）。
 *
 * R-20 修复（2026-10-28）：
 *  - **多库上下文**：多库模式下真实路径由 `context.applyLibraryPaths()` 覆写。
 *    此前这里直接 `runScan()`，扫的是默认 `iCloudPhoto/` 并写进 `server/cache/library.db`
 *    —— 一个网页端根本不会读的库，用户看到的是「扫完了但一张没变」。
 *    现在与 `index.ts` 启动流程一致：先切到激活库上下文再扫。
 *  - **队列收尾**：扫完立刻 `process.exit(0)` 会把刚入队的缩略图预热切成半截。
 *    默认等队列排空再退出；`--no-thumbs` 则干脆不入队（只入库、不预热，最快）。
 */
import { applyLibraryPaths, getCurrentLibrary, resetLibraryPaths } from './context.js'
import { closeDb } from './db/index.js'
import { waitForThumbnailIdle } from './pipeline/queue.js'
import { runScan, scanProgress } from './scanner/index.js'

const noThumbs = process.argv.includes('--no-thumbs')

// 与 index.ts 启动一致：有激活库就切到它的路径，无库时保持默认（首次使用尚未建库）
const lib = getCurrentLibrary()
if (lib) {
  applyLibraryPaths(lib)
  console.log(`照片库：#${lib.id} ${lib.name} → ${lib.library_root}`)
} else {
  resetLibraryPaths()
  console.warn('尚未创建照片库，按默认路径扫描（建议先用网页端建库）')
}

runScan('manual', { enqueueThumbnails: !noThumbs })
  .then(async () => {
    console.log('扫描完成。', scanProgress)
    if (!noThumbs) {
      console.log('等待缩略图预热完成（Ctrl+C 可中断，已写入的缓存不会损坏）…')
      await waitForThumbnailIdle()
      console.log('缩略图预热完成。')
    }
    closeDb()
    process.exit(0)
  })
  .catch((err) => {
    console.error('扫描失败:', err)
    closeDb()
    process.exit(1)
  })
