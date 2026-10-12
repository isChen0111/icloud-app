/**
 * 照片库注册表（应用级 meta.db，多库共享一份）
 *
 * 设计要点（对应架构文档 §3.2 单活跃库模型）：
 * 1. 每个照片库独立一组路径：library_root（icloudpd 下载目标，文件夹结构 %Y/%m/%d 锁定）、
 *    cache_dir（缩略图/视频封面/该库 DB，路径 = server/cache/lib<id>/）、cookie_dir（icloudpd 会话）。
 * 2. 目录与库名解耦：库名只是显示别名（meta.db），目录用稳定标识 lib<id>，
 *    照片统一放 <项目根>/iCloudPhoto/lib<id>，缓存统一放 server/cache/lib<id>。
 * 3. 单活跃库：active 标记，一次只有一个库处于激活；切换 = 停旧任务 → 关旧 DB → 覆写全局
 *    config 指向新库 → 重扫（详见 context.ts / routes）。
 * 4. P0 启动流程：无库时不隐式建库，前端走首次引导（新建库 → 链接 iCloud → 拉取）。
 */
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { config, projectRoot } from '../config.js'

export interface LibraryRow {
  id: number
  name: string
  library_root: string
  cache_dir: string
  cookie_dir: string
  account: string | null
  auth_status: 'none' | 'authed' | 'expired'
  last_sync_at: string | null
  created_at: string
  active: number
  /** 增量同步：连续 N 个文件本地已存在则停（默认 20） */
  until_found: number
  /** 下载限量：只处理最近 N 张（0=全量不限，默认 0） */
  recent_limit: number
}

/** Windows 路径非法字符（库名会用作 cache/cookie 目录名，须过滤） */
const INVALID_DIR_CHARS = /[\\/:*?"<>|]/g

/** 库名校验：非空、≤32 字符、唯一、不含路径非法字符 */
export function validateLibraryName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return '库名不能为空'
  if (trimmed.length > 32) return '库名不能超过 32 个字符'
  if (INVALID_DIR_CHARS.test(trimmed)) return '库名不能包含 \\ / : * ? " < > | 字符'
  return null
}

let _meta: Database.Database | null = null

/** 获取库注册表 DB（首次调用自动建库 + 建表） */
export function getMetaDb(): Database.Database {
  if (_meta) return _meta
  fs.mkdirSync(path.dirname(config.metaDbPath), { recursive: true })
  const db = new Database(config.metaDbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS libraries (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT UNIQUE NOT NULL,
      library_root  TEXT NOT NULL,
      cache_dir     TEXT NOT NULL,
      cookie_dir    TEXT NOT NULL,
      account       TEXT,
      auth_status   TEXT NOT NULL DEFAULT 'none',
      last_sync_at  TEXT,
      created_at    TEXT NOT NULL,
      active        INTEGER NOT NULL DEFAULT 0,
      until_found   INTEGER NOT NULL DEFAULT 20,
      recent_limit  INTEGER NOT NULL DEFAULT 0
    );
  `)
  // 老库迁移：已存在的表补列（CREATE TABLE IF NOT EXISTS 不会加新列）
  const cols = db.prepare(`PRAGMA table_info(libraries)`).all() as { name: string }[]
  const colNames = new Set(cols.map((c) => c.name))
  if (!colNames.has('until_found')) db.exec(`ALTER TABLE libraries ADD COLUMN until_found INTEGER NOT NULL DEFAULT 20`)
  if (!colNames.has('recent_limit')) db.exec(`ALTER TABLE libraries ADD COLUMN recent_limit INTEGER NOT NULL DEFAULT 0`)
  _meta = db
  return db
}

/** 行 → 对象映射（DB 返回 snake_case，这里转成接口形态） */
function toRow(row: Record<string, unknown>): LibraryRow {
  return {
    id: row.id as number,
    name: row.name as string,
    library_root: row.library_root as string,
    cache_dir: row.cache_dir as string,
    cookie_dir: row.cookie_dir as string,
    account: (row.account as string | null) ?? null,
    auth_status: (row.auth_status as LibraryRow['auth_status']) ?? 'none',
    last_sync_at: (row.last_sync_at as string | null) ?? null,
    created_at: row.created_at as string,
    active: row.active as number,
    until_found: (row.until_found as number) ?? 20,
    recent_limit: (row.recent_limit as number) ?? 0,
  }
}

/**
 * 建库（首次引导流程用）。目录自动派生，不开放手填。
 *
 * 目录规则（多库分离设计）：
 *   照片根  = <项目根>/iCloudPhoto/lib<id>     —— 库名只是显示别名，不参与路径；
 *   缓存    = server/cache/lib<id>             —— library.db / stats.json / thumbs / cookies 都在这；
 *   注册表  = server/cache/meta.db             —— 所有库共享（放 cache 根，不随库切换）。
 * 先 INSERT 拿到自增 id，再回填目录路径。
 */
export function createLibrary(name: string): LibraryRow {
  const meta = getMetaDb()
  const trimmed = name.trim()
  const now = new Date().toISOString()
  // 单活跃库：仅当当前没有任何激活库（首次建库）时才激活新库；
  // 已有激活库时新建库不激活——创建完不自动切换主页面/下拉/设置中心的当前库
  const existingActive = meta.prepare(`SELECT id FROM libraries WHERE active = 1`).get() as { id: number } | undefined
  const active = existingActive ? 0 : 1
  const info = meta
    .prepare(
      `INSERT INTO libraries (name, library_root, cache_dir, cookie_dir, created_at, active)
       VALUES (?, '', '', '', ?, ?)`,
    )
    .run(trimmed, now, active)
  const id = info.lastInsertRowid as number
  // 照片根：<项目根>/iCloudPhoto/lib<id>
  const photosRoot = path.join(projectRoot, 'iCloudPhoto', `lib${id}`)
  const cacheDir = path.join(path.dirname(config.metaDbPath), `lib${id}`)
  const cookieDir = path.join(cacheDir, 'cookies')
  meta
    .prepare(`UPDATE libraries SET library_root = ?, cache_dir = ?, cookie_dir = ? WHERE id = ?`)
    .run(photosRoot, cacheDir, cookieDir, id)
  // 激活新库时（首次建库）清掉其他库的 active 标记
  if (active === 1) {
    meta.prepare(`UPDATE libraries SET active = 0 WHERE id <> ?`).run(id)
  }
  return getLibraryById(id)!
}

export function listLibraries(): LibraryRow[] {
  const rows = getMetaDb().prepare(`SELECT * FROM libraries ORDER BY id ASC`).all() as Record<string, unknown>[]
  return rows.map(toRow)
}

export function getLibraryById(id: number): LibraryRow | null {
  const row = getMetaDb().prepare(`SELECT * FROM libraries WHERE id = ?`).get(id) as Record<string, unknown> | undefined
  return row ? toRow(row) : null
}

export function getActiveLibrary(): LibraryRow | null {
  const row = getMetaDb().prepare(`SELECT * FROM libraries WHERE active = 1`).get() as Record<string, unknown> | undefined
  return row ? toRow(row) : null
}

/** 切换激活库（单活跃库模型） */
export function setActiveLibrary(id: number): LibraryRow {
  const meta = getMetaDb()
  meta.prepare(`UPDATE libraries SET active = 0`).run()
  meta.prepare(`UPDATE libraries SET active = 1 WHERE id = ?`).run(id)
  return getLibraryById(id)!
}

/**
 * 启动时取激活库（不再自动注册默认库）。
 * 无库 → 返回 null：后端正常监听，前端进入首次引导（新建库 → 链接 iCloud → 拉取），
 * 与 P0 多库分离设计一致（从 0 开始建库，不隐式创建「我的相册」）。
 */
export function ensureDefaultLibrary(): LibraryRow | null {
  return getActiveLibrary()
}

/** 认证状态更新（认证成功 / 过期标记） */
export function updateLibraryAuth(id: number, patch: { account?: string; auth_status?: LibraryRow['auth_status'] }): void {
  const sets: string[] = []
  const vals: unknown[] = []
  if (patch.account !== undefined) {
    sets.push('account = ?')
    vals.push(patch.account)
  }
  if (patch.auth_status !== undefined) {
    sets.push('auth_status = ?')
    vals.push(patch.auth_status)
  }
  if (sets.length === 0) return
  vals.push(id)
  getMetaDb().prepare(`UPDATE libraries SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
}

/** 记录最近同步时间 */
export function touchLibrarySync(id: number): void {
  getMetaDb().prepare(`UPDATE libraries SET last_sync_at = ? WHERE id = ?`).run(new Date().toISOString(), id)
}

/** 更新同步参数（until_found / recent_limit） */
export function updateLibraryConfig(id: number, patch: { untilFound?: number; recentLimit?: number }): void {
  const sets: string[] = []
  const vals: unknown[] = []
  if (patch.untilFound !== undefined) {
    sets.push('until_found = ?')
    vals.push(Math.max(1, Math.floor(patch.untilFound)))
  }
  if (patch.recentLimit !== undefined) {
    sets.push('recent_limit = ?')
    vals.push(Math.max(0, Math.floor(patch.recentLimit)))
  }
  if (sets.length === 0) return
  vals.push(id)
  getMetaDb().prepare(`UPDATE libraries SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
}

/** 删除库（仅移除注册；不删照片文件。删除前确保切到其他库） */
export function deleteLibrary(id: number): void {
  getMetaDb().prepare(`DELETE FROM libraries WHERE id = ?`).run(id)
}
