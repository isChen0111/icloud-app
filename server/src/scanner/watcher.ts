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
/** 最小触发间隔的等待定时器（距上次派发不足间隔时用它补齐） */
let throttleTimer: NodeJS.Timeout | null = null
/** 本会话最近一次派发 watcher 扫描的时刻（`Date.now()`，0 = 本会话还没派发过） */
let lastScanDispatchAt = 0

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

/**
 * 距离「允许派发下一次 watcher 扫描」还要等多久（毫秒，0 = 立刻可以）。
 *
 * 导出为纯函数是为了能直接钉住语义（真实定时器测不动：2s awaitWriteFinish +
 * 1.5s 防抖 + 全库扫描，单测只能靠 sleep 撞运气）。
 */
export function throttleWait(now: number, lastDispatchAt: number, minIntervalMs: number): number {
  if (minIntervalMs <= 0 || lastDispatchAt <= 0) return 0
  return Math.max(0, minIntervalMs - (now - lastDispatchAt))
}

/** 事件到达：重置防抖窗口（gen = 注册该监听器时的会话代数） */
function scheduleScan(gen: number): void {
  if (gen !== watcherGeneration) return // 会话已结束：迟到事件直接丢弃
  dirty = true
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    fireScan(gen)
  }, 1500)
}

/**
 * 真正派发扫描。三道闸门按顺序：会话代数 → 扫描互斥 → 最小间隔。
 *
 * 与旧实现的差别：扫描中重排以前是「2s 后再走一遍 scheduleScan」，于是又吃一次
 * 1.5s 防抖（实际约 3.5s 才补扫）；现在直接 2s 后进 fireScan，语义与注释一致。
 */
function fireScan(gen: number): void {
  if (gen !== watcherGeneration) return // 等待期间被 stopWatcher 了
  if (scanProgress.status === 'scanning') {
    // 扫描正在跑：2s 后再检查（此时 dirty 仍为 true）
    if (!retryTimer) {
      retryTimer = setTimeout(() => {
        retryTimer = null
        fireScan(gen)
      }, 2000)
    }
    return
  }
  // 最小触发间隔：下载/拷贝密集时事件会一波接一波，光靠防抖只能合并「静默前」的
  // 那一波，持续写入会让扫描一轮接一轮连着跑（每轮都是全库遍历 + stat）。这里给
  // 一个下限，闸门只作用于 watcher 自己派发的扫描，手动/导入扫描不受影响。
  const wait = throttleWait(Date.now(), lastScanDispatchAt, config.scanMinIntervalMs)
  if (wait > 0) {
    if (!throttleTimer) {
      throttleTimer = setTimeout(() => {
        throttleTimer = null
        fireScan(gen)
      }, wait)
    }
    return
  }
  dirty = false
  lastScanDispatchAt = Date.now()
  void runScan('watcher').catch((err) => {
    console.error('[watcher] 同步失败:', (err as Error).message)
  })
}

/**
 * 排除规则：
 * 1. 隐藏文件/目录（. 开头），如 .DS_Store、系统临时文件；
 * 2. 缓存产物（stats.json / library.db / thumbs / tmp / cookies 等）。
 *    当照片库根与缓存目录重合时（如测试库 cache 与 library 同一目录），
 *    缓存写入会自触发扫描形成死循环；显式排除后，只有真实照片文件变化才触发扫描；
 * 3. 原子写的中间文件（`*.part`，见 import/fsImport 的 copyAtomically）。
 *    这类文件每个会产生 add + rename 两个事件；下载节奏稀疏时无所谓，但本地导入
 *    每秒能落几百个，`awaitWriteFinish` 会为每个「待确认」文件每 100ms 轮询一次、
 *    连查 2s，几百个并发就是每秒上万次 stat + 同样数量的定时器。
 *
 * 刻意**不按扩展名过滤**：chokidar 的 `ignored` 对目录也会调用，按扩展名判定会把
 * `icloud` / `import` 这类无扩展名目录整个忽略掉，目录内的事件就全丢了。walkDir
 * 本来就按扩展名过滤，多余事件只是多一次防抖，代价远小于误杀目录。
 */
export function isIgnored(p: string): boolean {
  const base = path.basename(p)
  if (base.startsWith('.')) return true
  if (base === 'stats.json' || base === 'library.db' || base === 'cookies') return true
  if (base.endsWith('.db-wal') || base.endsWith('.db-shm')) return true
  if (base.endsWith('.part')) return true
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
  if (throttleTimer) {
    clearTimeout(throttleTimer)
    throttleTimer = null
  }
  // 闸门是「会话内」的约束：换库/重开会话不该继承上一个库的派发时刻
  lastScanDispatchAt = 0
  dirty = false
  if (watcher) {
    const w = watcher
    watcher = null
    // 审查 C-16：close() 返回 Promise，旧实现 `void watcher.close()` 把拒绝直接丢掉 →
    // 关闭失败时变成 unhandledRejection，进而在优雅关闭流程里触发一次「未处理的 Promise 拒绝」，
    // 把真正的失败原因埋掉。这里显式捕获并打印。
    void w.close().catch((err: unknown) => {
      console.error('[watcher] 关闭失败:', err instanceof Error ? err.message : String(err))
    })
  }
}
