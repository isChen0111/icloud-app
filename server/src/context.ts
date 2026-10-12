/**
 * 激活库上下文（P0 单活跃库模型）
 *
 * 策略：启动/切库时把全局 config.libraryRoot / cacheDir / dbPath 覆写为激活库的路径。
 * 现有 scanner / watcher / pipeline / routes 全部通过 config 取路径，因此零改动自动跟随激活库，
 * 避免把「当前库」概念渗透到每个模块。
 *
 * 切换时序（对应架构文档 §3.2.2）：
 *   停旧库 watcher → 关闭旧库 DB 连接 → 覆写 config → 启动新库 watcher → 触发新库增量扫描。
 * 任务队列为全局单队列（P1 才带 library_id），P0 保持单库上下文、切库前任务清空。
 */
import path from 'node:path'
import { config, projectRoot } from './config.js'
import type { LibraryRow } from './db/libraries.js'
import { getActiveLibrary } from './db/libraries.js'

/**
 * 当前激活库（实时读 meta.db 的 active 标记）。
 * 注意：不缓存内存快照——认证状态（auth_status）、库信息变更后立即反映到 stats/路由，
 *       避免出现「meta.db 已更新但接口返回旧值」的不一致。
 */
export function getCurrentLibrary(): LibraryRow | null {
  return getActiveLibrary()
}

/** 把全局 config 覆写为激活库路径（现有模块无需改动） */
export function applyLibraryPaths(lib: LibraryRow): void {
  config.libraryRoot = lib.library_root
  config.cacheDir = lib.cache_dir
  config.dbPath = path.join(lib.cache_dir, 'library.db')
}

/** 重置为默认路径（删除最后一个照片库后回到无库状态；前端整页刷新走首次引导） */
export function resetLibraryPaths(): void {
  config.libraryRoot = path.join(projectRoot, 'iCloudPhoto')
  config.cacheDir = path.join(projectRoot, 'server', 'cache')
  config.dbPath = path.join(projectRoot, 'server', 'cache', 'library.db')
}
