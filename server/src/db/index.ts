/**
 * 数据库连接（better-sqlite3 单例）
 *
 * better-sqlite3 是同步 API：简单、快、无回调地狱。
 * 1.2 万行级别的查询都是毫秒级，完全够用。
 * 注意：better-sqlite3 的 WAL 模式让读写并发更稳。
 */
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { SCHEMA_SQL } from './schema.js'

let _db: Database.Database | null = null

/** 获取数据库实例（首次调用时自动建库 + 建表） */
export function getDb(): Database.Database {
  if (_db) return _db

  // 确保 cache 目录存在（数据库与缩略图缓存同目录）
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true })

  const db = new Database(config.dbPath)
  db.pragma('journal_mode = WAL') // WAL：读不阻塞写，滚动浏览时缩略图生成不影响查询
  db.pragma('synchronous = NORMAL') // 平衡持久性与性能
  db.exec(SCHEMA_SQL)

  // —— FTS5 索引一致性回填 ——
  // 场景：每次启动（schema DROP+CREATE 后必为空）、扫描中断等。
  // 对比行数：不一致则全量重建（11k 行毫秒级，扫描入库后正常状态两侧相等）。
  const ftsCount = (db.prepare(`SELECT count(*) AS c FROM assets_fts`).get() as { c: number }).c
  const assetCount = (db.prepare(`SELECT count(*) AS c FROM assets`).get() as { c: number }).c
  if (ftsCount !== assetCount) {
    db.transaction(() => {
      db.exec(`DELETE FROM assets_fts`)
      db.exec(
        `INSERT INTO assets_fts(rowid, search_text, date_taken, date_compact)
         SELECT id,
                lower(filename),
                date_taken,
                replace(replace(replace(replace(date_taken, '-', ''), ':', ''), '.', ''), 'T', '')
         FROM assets`,
      )
    })()
    console.log(`[db] FTS 索引已重建：${assetCount} 行`)
  }

  _db = db
  return db
}

/** 资产行类型（与 assets 表字段一一对应） */
export interface AssetRow {
  id: number
  file_path: string
  type: 'photo' | 'video' | 'live'
  filename: string
  date_taken: string
  width: number | null
  height: number | null
  duration: number | null
  orientation: number | null
  gps_lat: number | null
  gps_lon: number | null
  live_video: string | null
  thumb_status: string
  detail_status: string
  poster_status: string
}
