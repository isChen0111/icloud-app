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

/**
 * 监听会话代数（R-11）
 *
 * chokidar 的 `close()` 是异步的（`void` 调用、不等待），且 `awaitWriteFinish`
 * 会把文件事件压后 2s 才发出。换库时可能出现的时序：
 *
 *   stopWatcher() → 旧 watcher 的回调仍进了事件循环 → scheduleScan()
 *   → 1.5s 后 runScan()  ← 而它读的是全局 config.libraryRoot（已被换成新库）
 *
 * 结果是对着刚切过去的新库白跑一次全量扫描。每次 start/stop 都递增代数，
 * 回调注册时捕获当时的代数，执行时对不上即丢弃。
 */
let watcherGeneration = 0

/** 当前监听会话代数（导出供测试固定「stop 必须递增」这一约束） */
export function currentWatcherGeneration(): number {
  return watcherGeneration
}

/** 事件到达：重置防抖窗口（gen = 注册该监听器时的会话代数） */
function scheduleScan(gen: number): void {
  if (gen !== watcherGeneration) return // 会话已结束：迟到事件直接丢弃
  dirty = true
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    if (gen !== watcherGeneration) return // 防抖等待期间被 stopWatcher 了
    if (scanProgress.status === 'scanning') {
      // 扫描正在跑：2s 后再检查（此时 dirty 仍为 true，会再走防抖）
      if (!retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = null
          scheduleScan(gen)
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

/**
 * 排除规则：
 * 1. 隐藏文件/目录（. 开头），如 .DS_Store、系统临时文件；
 * 2. 缓存产物（stats.json / library.db / thumbs / tmp / cookies 等）。
 *    当照片库根与缓存目录重合时（如测试库 cache 与 library 同一目录），
 *    缓存写入会自触发扫描形成死循环；显式排除后，只有真实照片文件变化才触发扫描。
 */
function isIgnored(p: string): boolean {
  const base = path.basename(p)
  if (base.startsWith('.')) return true
  if (base === 'stats.json' || base === 'library.db' || base === 'cookies') return true
  if (base.endsWith('.db-wal') || base.endsWith('.db-shm')) return true
  if (base === 'thumbs' || base === 'tmp' || base === 'blur') return true
  return false
}

/** 启动热监听（幂等：重复调用只起一个 watcher） */
export function startWatcher(): void {
  if (watcher) return
  const gen = ++watcherGeneration
  watcher = chokidar.watch(config.libraryRoot, {
    // 启动时不触发已有文件（启动同步已处理），只监听此后变化
    ignoreInitial: true,
    // 文件写入稳定（2s 无变化）才视为"完成"，避免读到拷贝一半的文件。
    // 注意：iCloudPD 连续下载大视频时，文件可能分块写入、中间停顿，
    // 500ms 太短会误判"写完了"导致抽帧失败；2s 更稳妥。
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 },
    // 忽略隐藏文件 + 缓存产物（见 isIgnored）
    ignored: isIgnored,
  })

  // 任一文件事件（新增/变化/删除/目录删除）都触发防抖同步
  // 事件回调统一带上本会话代数：stopWatcher 之后到达的回调会被 scheduleScan 丢弃
  const onFsEvent = (): void => scheduleScan(gen)
  watcher.on('add', onFsEvent)
  watcher.on('change', onFsEvent)
  watcher.on('unlink', onFsEvent)
  watcher.on('unlinkDir', onFsEvent)

  watcher.on('error', (err: unknown) => {
    console.error('[watcher] 监听错误:', err instanceof Error ? err.message : String(err))
  })

  console.log(`[watcher] 已开始监听照片库: ${config.libraryRoot}`)
}

/** 停止热监听（切库前调用：停旧库 watcher，防新事件打向旧库扫描） */
export function stopWatcher(): void {
  // 先作废代数：此后所有已排队的回调（含防抖/重试定时器）都会被判为过期
  watcherGeneration++
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  dirty = false
  if (watcher) {
    void watcher.close()
    watcher = null
  }
}
