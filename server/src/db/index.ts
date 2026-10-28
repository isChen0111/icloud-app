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
import { DATE_BASIS_VERSION, FTS_SCHEMA_VERSION, SCHEMA_SQL } from './schema.js'
import { hasTimezoneOffset, toDateCompact, toLocalIso } from '../utils/date.js'

let _real: Database.Database | null = null
let _realPath: string | null = null

/** 关闭当前数据库连接（切库前调用） */
export function closeDb(): void {
  if (_real) {
    try {
      _real.close()
    } catch {
      // 连接已关闭等场景忽略
    }
    _real = null
    _realPath = null
  }
}

/**
 * 全量回填 FTS 索引（R-26）：date_compact 统一由 toDateCompact() 生成。
 *
 * 原实现用 SQL 四次 replace 依次去掉 - : . T → "20240913084028"，
 * 而扫描入库用 `replace(/[^0-9a-zA-Z]/g, '')` 保留 T → "20240913T084028"，
 * 同一资产因此有两种索引表示（搜 "20240913T0840" 只命中前者、搜 "202409130840" 只命中后者）。
 * 现在两条路径共用同一个工具函数；万级行在 JS 里算一次是毫秒级，
 * 且回填只在「结构版本不符」或「行数不符」时发生，不影响常规启动。
 */
function backfillFts(db: Database.Database): number {
  const rows = db.prepare(`SELECT id, filename, date_taken FROM assets`).all() as {
    id: number
    filename: string
    date_taken: string | null
  }[]
  const insert = db.prepare(
    `INSERT INTO assets_fts(rowid, search_text, date_taken, date_compact) VALUES (?, lower(?), ?, ?)`,
  )
  for (const row of rows) insert.run(row.id, row.filename, row.date_taken, toDateCompact(row.date_taken))
  return rows.length
}

/**
 * 把 `assets.date_taken` 统一成「本地时间 + 时区偏移」表示（审查 R-08）。
 *
 * 迁移前同一列混着两种基准：EXIF 路径写 UTC（`2026-10-25T08:47:15.000Z`）、
 * 目录兜底路径写本地零点（`2026-10-24T00:00:00+08:00`）。后果见 utils/date.ts 的 toLocalIso 注释
 * （字符串排序错位 + 按月分组切到 UTC 月份）。
 *
 * 幂等：完成状态记在 `app_meta.date_basis`，重复启动直接跳过。
 * 单独一行解析失败（脏数据）时保留原值、不阻断其他行。
 *
 * @returns 实际改写的行数；0 表示无需迁移或早已完成
 */
function migrateDateBasis(db: Database.Database): number {
  const row = db.prepare(`SELECT value FROM app_meta WHERE key = 'date_basis'`).get() as
    | { value: string }
    | undefined
  const current = row ? Number(row.value) : 0
  if (current >= DATE_BASIS_VERSION) return 0

  const assets = db.prepare(`SELECT id, date_taken FROM assets`).all() as {
    id: number
    date_taken: string
  }[]
  const update = db.prepare(`UPDATE assets SET date_taken = ? WHERE id = ?`)
  const markDone = db.prepare(
    `INSERT INTO app_meta(key, value) VALUES ('date_basis', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )

  let changed = 0
  db.transaction(() => {
    for (const asset of assets) {
      if (hasTimezoneOffset(asset.date_taken)) continue
      const parsed = new Date(asset.date_taken)
      const next = Number.isNaN(parsed.getTime()) ? null : toLocalIso(parsed)
      if (!next) continue
      update.run(next, asset.id)
      changed++
    }
    markDone.run(String(DATE_BASIS_VERSION))
  })()
  return changed
}

/** 打开（或复用）与 config.dbPath 对应的真实连接，并完成建表/迁移初始化 */
function ensureOpen(): Database.Database {
  if (_real && _realPath === config.dbPath) return _real
  if (_real) {
    try {
      _real.close()
    } catch {
      // ignore
    }
    _real = null
    _realPath = null
  }

  // 确保 cache 目录存在（数据库与缩略图缓存同目录）
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true })

  const db = new Database(config.dbPath)
  db.pragma('journal_mode = WAL') // WAL：读不阻塞写，滚动浏览时缩略图生成不影响查询
  db.pragma('synchronous = NORMAL') // 平衡持久性与性能
  db.exec(SCHEMA_SQL)

  const assetColumns = new Set(
    (db.prepare(`PRAGMA table_info(assets)`).all() as { name: string }[]).map((column) => column.name),
  )
  if (!assetColumns.has('thumb_error')) db.exec(`ALTER TABLE assets ADD COLUMN thumb_error TEXT`)
  if (!assetColumns.has('thumb_ignored')) {
    db.exec(`ALTER TABLE assets ADD COLUMN thumb_ignored INTEGER NOT NULL DEFAULT 0`)
  }
  // F-03 修复：源文件签名列（size + mtimeMs）——旧库补齐，新库建表已含
  if (!assetColumns.has('file_size')) db.exec(`ALTER TABLE assets ADD COLUMN file_size INTEGER`)
  if (!assetColumns.has('file_mtime')) db.exec(`ALTER TABLE assets ADD COLUMN file_mtime INTEGER`)

  // R-08：date_taken 基准统一。必须放在 FTS 判断之前——改了 date_taken 就得重建索引，
  // 否则 FTS 里还留着旧基准的 date_taken / date_compact（搜索结果与排序会跟主表不一致）。
  const dateBasisChanged = migrateDateBasis(db)
  if (dateBasisChanged > 0) {
    // 清空索引，交给下面的「行数不符 → 回填」分支重新生成。
    // 不在这里直接回填，是为了让回填逻辑只有一条路径，避免两次实现走偏。
    db.exec(`DELETE FROM assets_fts`)
    console.log(`[db] date_taken 已统一为本地偏移表示：${dateBasisChanged} 行`)
  }

  const ftsCount = (db.prepare(`SELECT count(*) AS c FROM assets_fts`).get() as { c: number }).c
  const assetCount = (db.prepare(`SELECT count(*) AS c FROM assets`).get() as { c: number }).c
  const ftsVersion = db.pragma('user_version', { simple: true }) as number
  if (ftsVersion !== FTS_SCHEMA_VERSION) {
    // 结构重建：DROP + CREATE（schema.ts 用 IF NOT EXISTS，此处先 DROP 强制重建）
    db.transaction(() => {
      db.exec(`DROP TABLE IF EXISTS assets_fts`)
      db.exec(
        `CREATE VIRTUAL TABLE assets_fts USING fts5(
           search_text,
           date_taken,
           date_compact,
           tokenize = 'trigram'
         )`,
      )
      backfillFts(db)
      db.pragma(`user_version = ${FTS_SCHEMA_VERSION}`)
    })()
    console.log(`[db] FTS 表结构 v${FTS_SCHEMA_VERSION} 已重建：${assetCount} 行`)
  } else if (ftsCount !== assetCount) {
    // 结构已是最新：行数不一致只回填（万级行毫秒级）
    db.transaction(() => {
      db.exec(`DELETE FROM assets_fts`)
      backfillFts(db)
    })()
    console.log(`[db] FTS 索引已回填：${assetCount} 行`)
  }

  _real = db
  _realPath = config.dbPath
  return db
}

/**
 * 稳定代理（切库零改动关键）：
 * 现有路由在 register 时持有 getDb() 的引用（如 const db = getDb()），
 * 切库后旧引用必须仍然可用且指向新库。这里返回一个永不失效的 Proxy，
 * 每次属性访问动态转发到"当前激活库"的真实连接——路由代码一行不用改。
 */
const proxy = new Proxy({} as Database.Database, {
  get(_target, prop) {
    const real = ensureOpen()
    const value = (real as unknown as Record<string, unknown>)[prop as string]
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(real) : value
  },
})

/** 获取数据库实例（首次调用时自动建库 + 建表） */
export function getDb(): Database.Database {
  return proxy
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
