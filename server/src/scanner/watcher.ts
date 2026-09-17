/**
 * 目录热监听（P2+-1）
 *
 * 用 chokidar 监听照片库目录树，手动拷入/删除/重命名文件时自动触发一次
 * 全量同步（runScan）。同步本身是幂等增量，所以监听器只需做三件事：
 *   ① 事件防抖合并：拷一批照片会触发几十上百个 add 事件，合并成一次扫描
 *   ② 扫描互斥：同步已在跑时延后补一次，避免并发全量扫描
 *   ③ 忽略初始事件：启动时目录里已存在的文件不触发（由启动同步负责）
 */
import path from 'node:path'
import chokidar from 'chokidar'
import { config } from '../config.js'
import { runScan, scanProgress } from './index.js'

/** chokidar 实例（单例）。类型用 ReturnType 推导，兼容 v5 类型导出 */
let watcher: ReturnType<typeof chokidar.watch> | null = null

/** 事件防抖定时器：1.5s 内合并连续文件事件 */
let debounceTimer: NodeJS.Timeout | null = null
/** 扫描互斥重试定时器：扫描中时延后补一次 */
let retryTimer: NodeJS.Timeout | null = null

/** 是否有"未消费"的变更（扫描期间又来新事件时置 true，扫描结束后再排一次） */
let dirty = false

/** 事件到达：重置防抖窗口 */
function scheduleScan(): void {
  dirty = true
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    if (scanProgress.status === 'scanning') {
      // 扫描正在跑：2s 后再检查（此时 dirty 仍为 true，会再走防抖）
      if (!retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = null
          scheduleScan()
        }, 2000)
      }
      return
    }
    dirty = false
    void runScan('watcher').catch((err) => {
      console.error('[watcher] 同步失败:', (err as Error).message)
    })
  }, 1500)
}

/** 启动热监听（幂等：重复调用只起一个 watcher） */
export function startWatcher(): void {
  if (watcher) return
  watcher = chokidar.watch(config.libraryRoot, {
    // 启动时不触发已有文件（启动同步已处理），只监听此后变化
    ignoreInitial: true,
    // 文件写入稳定（500ms 无变化）才视为"完成"，避免读到拷贝一半的文件
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    // 忽略隐藏文件/目录（. 开头），如 .DS_Store、系统临时文件
    ignored: (p) => path.basename(p).startsWith('.'),
  })

  // 任一文件事件（新增/变化/删除/目录删除）都触发防抖同步
  watcher.on('add', scheduleScan)
  watcher.on('change', scheduleScan)
  watcher.on('unlink', scheduleScan)
  watcher.on('unlinkDir', scheduleScan)

  watcher.on('error', (err: unknown) => {
    console.error('[watcher] 监听错误:', err instanceof Error ? err.message : String(err))
  })

  console.log(`[watcher] 已开始监听照片库: ${config.libraryRoot}`)
}
