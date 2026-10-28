/**
 * 数据库启动迁移单元测试（R-26 回归保护，2026-10-28）
 *
 * 为什么需要这组测试：
 *   `ensureOpen()` 在每次打开库时都可能改存量数据（补列 / 重建 FTS / 回填索引），
 *   这类代码写错的后果是**静默的**——不报错、不崩，只是数据悄悄变成另一种样子。
 *   R-26 当初是靠一次性临时脚本手验的，验完就删了，没有任何东西拦住后续回归。
 *   这里把「用系统临时目录造一个旧库 → 走真实 getDb() 启动路径 → 断言结果」固定下来，
 *   以后所有针对存量数据的迁移（如 R-08 时间基准统一）都复用同一套骨架。
 *
 * 安全边界：
 *   全程只操作 `os.tmpdir()` 下新建的临时库，不改 `config.dbPath` 的默认值（用例结束恢复），
 *   不读写任何真实照片库或 `server/cache`。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { config } from '../config.js'
import { closeDb, getDb } from './index.js'
import { FTS_SCHEMA_VERSION, SCHEMA_SQL } from './schema.js'
import { toDateCompact } from '../utils/date.js'

/** 用例期间会临时改写 config.dbPath，结束后恢复成进程启动时的值 */
const originalDbPath = config.dbPath

interface SeedAsset {
  id: number
  filePath: string
  filename: string
  dateTaken: string
}

interface SeedOptions {
  dbPath: string
  assets: SeedAsset[]
  /** 写入的 PRAGMA user_version（模拟旧版本库） */
  ftsVersion: number
  /** 只写前 N 个资产的 FTS 行，省略则全写（模拟「索引行数落后」） */
  ftsRowCount?: number
  /**
   * 自定义 FTS 里的 date_compact 值（模拟历史遗留的多种表示）。
   * 省略时用当前实现 toDateCompact()。
   */
  compactOf?: (asset: SeedAsset, index: number) => string
}

/** 在系统临时目录里分配一个独立的库文件路径 */
function makeTmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icloud-db-mig-'))
  return path.join(dir, 'library.db')
}

/**
 * 造一个「旧版本」的库：表结构用当前 SCHEMA_SQL（结构本身没变过），
 * 但把 user_version 和 FTS 内容刻意做成旧格式，让 ensureOpen() 必须动手迁移。
 */
function seedLegacyDb(opts: SeedOptions): void {
  const db = new Database(opts.dbPath)
  try {
    db.exec(SCHEMA_SQL)
    const insertAsset = db.prepare(
      `INSERT INTO assets (id, file_path, type, filename, date_taken) VALUES (?, ?, 'photo', ?, ?)`,
    )
    const insertFts = db.prepare(
      `INSERT INTO assets_fts(rowid, search_text, date_taken, date_compact) VALUES (?, lower(?), ?, ?)`,
    )
    const ftsRows = opts.ftsRowCount ?? opts.assets.length
    opts.assets.forEach((asset, index) => {
      insertAsset.run(asset.id, asset.filePath, asset.filename, asset.dateTaken)
      if (index < ftsRows) {
        const compact = opts.compactOf ? opts.compactOf(asset, index) : toDateCompact(asset.dateTaken)
        insertFts.run(asset.id, asset.filename, asset.dateTaken, compact)
      }
    })
    db.pragma(`user_version = ${opts.ftsVersion}`)
  } finally {
    db.close()
  }
}

/** 收尾：关连接（否则 Windows 上 WAL 文件占用删不掉）→ 恢复路径 → 删临时目录 */
function cleanup(dbPath: string): void {
  closeDb()
  config.dbPath = originalDbPath
  try {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
  } catch {
    // 临时目录删不掉不影响测试结论，系统会自己清
  }
}

const SAMPLE_ASSETS: SeedAsset[] = [
  { id: 1, filePath: '2024/09/13/IMG_0001.HEIC', filename: 'IMG_0001.HEIC', dateTaken: '2024-09-13T08:40:28' },
  { id: 2, filePath: '2024/09/14/IMG_0002.HEIC', filename: 'IMG_0002.HEIC', dateTaken: '2024-09-14T09:12:03' },
]

test('R-26 回归：v2 库启动即重建 FTS，两种历史 date_compact 表示统一为同一种', () => {
  const dbPath = makeTmpDbPath()
  try {
    seedLegacyDb({
      dbPath,
      assets: SAMPLE_ASSETS,
      ftsVersion: 2,
      // 复现迁移前的真实状况：扫描入库保留 T、启动回填删掉 T，同一资产两种表示
      compactOf: (asset, index) =>
        index === 0 ? toDateCompact(asset.dateTaken) : asset.dateTaken.replace(/[^0-9]/g, ''),
    })
    // 确认「旧表示」确实被写进去了，否则下面的断言等于没测
    const seeded = new Database(dbPath, { readonly: true })
    const before = seeded.prepare(`SELECT rowid, date_compact FROM assets_fts ORDER BY rowid`).all() as {
      rowid: number
      date_compact: string
    }[]
    seeded.close()
    assert.deepEqual(
      before.map((r) => r.date_compact),
      ['20240913T084028', '20240914091203'],
      '前置条件：旧库应同时存在「保留 T」与「删掉 T」两种表示',
    )

    config.dbPath = dbPath
    const db = getDb()

    assert.equal(
      Number(db.pragma('user_version', { simple: true })),
      FTS_SCHEMA_VERSION,
      '重建后结构版本应提升到当前版本',
    )
    const rows = db.prepare(`SELECT rowid, date_taken, date_compact FROM assets_fts ORDER BY rowid`).all() as {
      rowid: number
      date_taken: string
      date_compact: string
    }[]
    assert.equal(rows.length, SAMPLE_ASSETS.length, '重建后索引行数应等于资产数')
    for (const row of rows) {
      assert.equal(
        row.date_compact,
        toDateCompact(row.date_taken),
        `rowid=${row.rowid} 的 date_compact 应与 toDateCompact 一致（两种表示已统一）`,
      )
    }
    // 统一到「保留 T」的表示，而不是相反——这条是 R-26 的结论本身
    assert.deepEqual(rows.map((r) => r.date_compact), ['20240913T084028', '20240914T091203'])
  } finally {
    cleanup(dbPath)
  }
})

test('R-26 回归：结构版本已是最新但索引行数落后时，只补齐回填、不改版本', () => {
  const dbPath = makeTmpDbPath()
  try {
    seedLegacyDb({
      dbPath,
      assets: SAMPLE_ASSETS,
      ftsVersion: FTS_SCHEMA_VERSION,
      ftsRowCount: 1, // 索引只覆盖了 1 个资产（新增资产后未回填的典型状态）
    })
    config.dbPath = dbPath
    const db = getDb()

    assert.equal(
      Number(db.pragma('user_version', { simple: true })),
      FTS_SCHEMA_VERSION,
      '回填路径不应改结构版本（否则下次启动又会走重建）',
    )
    const rows = db.prepare(`SELECT rowid, date_taken, date_compact FROM assets_fts ORDER BY rowid`).all() as {
      rowid: number
      date_taken: string
      date_compact: string
    }[]
    assert.deepEqual(
      rows.map((r) => r.rowid),
      [1, 2],
      '两个资产都应进索引，缺失的那条要补上',
    )
    for (const row of rows) {
      assert.equal(row.date_compact, toDateCompact(row.date_taken), `rowid=${row.rowid} 回填值应正确`)
    }
  } finally {
    cleanup(dbPath)
  }
})

test('全新空库：首次打开即建表、版本置为当前值，且不误报迁移', () => {
  const dbPath = makeTmpDbPath()
  try {
    config.dbPath = dbPath
    const db = getDb()

    assert.equal(Number(db.pragma('user_version', { simple: true })), FTS_SCHEMA_VERSION)
    assert.equal((db.prepare(`SELECT count(*) AS c FROM assets`).get() as { c: number }).c, 0)
    assert.equal((db.prepare(`SELECT count(*) AS c FROM assets_fts`).get() as { c: number }).c, 0)
    // 空库要能正常写入并立即可搜：证明 assets_fts 是有效虚拟表而不是空壳
    db.prepare(
      `INSERT INTO assets (id, file_path, type, filename, date_taken) VALUES (1, '2024/09/13/A.HEIC', 'photo', 'A.HEIC', '2024-09-13T08:40:28')`,
    ).run()
    db.prepare(
      `INSERT INTO assets_fts(rowid, search_text, date_taken, date_compact) VALUES (1, lower('A.HEIC'), '2024-09-13T08:40:28', ?)`,
    ).run(toDateCompact('2024-09-13T08:40:28'))
    const hit = db.prepare(`SELECT count(*) AS c FROM assets_fts WHERE assets_fts MATCH ?`).get('20240913')
    assert.equal((hit as { c: number }).c, 1, '写入后应能用紧凑日期搜到')
  } finally {
    cleanup(dbPath)
  }
})
