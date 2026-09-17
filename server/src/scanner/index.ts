/**
 * 目录扫描 + 实况配对 + 元数据入库（入库流水线）
 *
 * 流程：
 *  ① 递归遍历照片库，按扩展名分类 图片 / 视频
 *  ② 实况配对：基名相同的 图片+视频 配成一对（对标 iCloudPD 的 suffix 命名策略）
 *     - HEIC 实况：IMG_1234.HEIC  ⇄  IMG_1234_HEVC.MOV
 *     - JPEG 实况：IMG_1234.JPG   ⇄  IMG_1234.MOV
 *  ③ 提取元数据（EXIF / ffprobe / 目录日期兜底）
 *  ④ UPSERT 入库，并把「待生成缩略图」的资产交给流水线队列
 *
 * 幂等性：以 file_path 为唯一键，重复扫描不会产生重复行。
 * 进度：progress 对象写入内存，/api/scan 可查询。
 */
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { getDb } from '../db/index.js'
import { readImageMeta, readVideoMeta, normalizeDate, parseDateFromDir, baseName } from '../metadata/index.js'
import { enqueueAsset } from '../pipeline/queue.js'
import { thumbCachePath } from '../pipeline/thumbnails.js'

/** 支持的媒体扩展名（小写） */
const IMAGE_EXTS = new Set(['.heic', '.heif', '.jpg', '.jpeg', '.png', '.gif', '.tiff'])
const VIDEO_EXTS = new Set(['.mov', '.mp4', '.m4v', '.avi'])

/** 扫描进度（内存态，简单够用） */
export const scanProgress = {
  status: 'idle' as 'idle' | 'scanning' | 'done' | 'error',
  /** 本次扫描触发来源：手动 / 热监听 / 启动 */
  source: 'idle' as 'idle' | 'manual' | 'watcher' | 'startup',
  totalFiles: 0,
  scannedFiles: 0,
  assetsFound: 0,
  livePairs: 0,
  message: '',
}

/** 单个待入库文件 */
interface RawFile {
  /** 相对库根的路径，如 2025/02/17/IMG_1234.HEIC */
  relPath: string
  /** 绝对路径 */
  absPath: string
  /** 文件名（含扩展名） */
  fileName: string
  kind: 'image' | 'video'
}

/** 已配对的资产：主资产 + 可选实况视频 */
interface PairedAsset {
  image: RawFile
  /** 配对的实况视频（可能无） */
  liveVideo: RawFile | null
}

/**
 * 递归遍历目录，返回相对路径列表。
 * 跳过隐藏目录（以 . 开头）；目录不可读（无权限/已删除）时跳过而非抛错，
 * 避免单个坏目录让整个扫描中断。
 */
function walkDir(dir: string): string[] {
  const results: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue // 隐藏文件/目录
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...walkDir(full))
    } else if (entry.isFile()) {
      results.push(full)
    }
  }
  return results
}

/** 主扫描入口：全量扫描 + 入库。可重复调用（增量幂等）。
 *
 * 容错与断点续跑（审查 P1-B1）：
 *  - 整体 try/catch：任何异常都把 scanProgress 置为 error 并上抛，
 *    不再"半途静默崩溃、状态卡在 scanning"。
 *  - 增量续跑：已入库的 file_path 直接跳过元数据提取（照片库是 iCloudPD
 *    只读快照，文件内容不变），中断后重跑只补新文件，无需全量重来。
 */
/**
 * 全量同步入口：遍历 + 配对 + 入库 + 删除对账。可重复调用（增量幂等）。
 * @param source 触发来源：manual（手动/API）/ watcher（热监听）/ startup（启动对账）
 */
export async function runScan(source: 'manual' | 'watcher' | 'startup' = 'manual'): Promise<void> {
  scanProgress.source = source
  const db = getDb()
  scanProgress.status = 'scanning'
  scanProgress.message = '正在遍历目录…'

  try {
  // ① 收集所有媒体文件
  const absPaths = walkDir(config.libraryRoot)
  const allFiles: RawFile[] = []
  for (const abs of absPaths) {
    const ext = path.extname(abs).toLowerCase()
    if (IMAGE_EXTS.has(ext)) allFiles.push({ relPath: path.relative(config.libraryRoot, abs), absPath: abs, fileName: path.basename(abs), kind: 'image' })
    else if (VIDEO_EXTS.has(ext)) allFiles.push({ relPath: path.relative(config.libraryRoot, abs), absPath: abs, fileName: path.basename(abs), kind: 'video' })
  }

  // 测试/调试用：限制扫描数量（SCAN_LIMIT 环境变量），验证管线时避免全量等待
  const files = config.scanLimit > 0 ? allFiles.slice(0, config.scanLimit) : allFiles
  scanProgress.totalFiles = files.length
  scanProgress.scannedFiles = 0

  // 已入库路径 → 现有元数据（增量续跑复用；配对修正时无需重新提取元数据）。
  // 注意：之前用 Set 直接 continue 跳过，会导致重扫时 type/live_video 配对修正
  // 永远不生效；改为 Map 后已入库资产也会执行 UPSERT（只更新 type/live_video）。
  interface ExistingMeta {
    dateTaken: string | null
    width: number | null
    height: number | null
    duration: number | null
    orientation: number | null
    gpsLat: number | null
    gpsLon: number | null
  }
  const existingMeta = new Map<string, ExistingMeta>()
  for (const r of db
    .prepare(
      `SELECT file_path, date_taken, width, height, duration, orientation, gps_lat, gps_lon FROM assets`,
    )
    .all() as {
    file_path: string
    date_taken: string | null
    width: number | null
    height: number | null
    duration: number | null
    orientation: number | null
    gps_lat: number | null
    gps_lon: number | null
  }[]) {
    existingMeta.set(r.file_path, {
      dateTaken: r.date_taken,
      width: r.width,
      height: r.height,
      duration: r.duration,
      orientation: r.orientation,
      gpsLat: r.gps_lat,
      gpsLon: r.gps_lon,
    })
  }

  // ② 实况配对：按「目录 + 配对基名」索引。
  //    配对基名 = 文件名去扩展名；对 *_HEVC.MOV 再去掉 _HEVC（与静止帧同名）。
  //    例：IMG_1234_HEVC.MOV → IMG_1234；IMG_1234.HEIC → IMG_1234
  //    ⚠ 配对必须限定在同一目录内：iCloudPD 会把同名文件（不同设备 / 编辑版本）
  //    归档进不同的日期目录，只看基名会把不同照片错误配对成一组，
  //    并导致同组多余视频（videos[0] 之外）被直接丢弃（曾丢失 3382 个视频）。
  const byPairKey = new Map<string, RawFile[]>()
  for (const f of files) {
    let base = baseName(f.fileName)
    if (f.kind === 'video' && base.endsWith('_HEVC')) base = base.slice(0, -'_HEVC'.length)
    // Windows 下 relPath 是反斜杠，统一转 / 再拼目录，保证跨平台一致
    const dirKey = path.posix.dirname(f.relPath.replace(/\\/g, '/'))
    const key = `${dirKey}/${base}`
    const arr = byPairKey.get(key) ?? []
    arr.push(f)
    byPairKey.set(key, arr)
  }

  // 组装主资产列表：图片永远是主资产；没有图片配对的视频才是独立视频资产
  const assets: PairedAsset[] = []
  let livePairs = 0
  const usedVideos = new Set<string>() // 已被实况配对占用的视频路径

  for (const [key, group] of byPairKey) {
    const images = group.filter((f) => f.kind === 'image')
    const videos = group.filter((f) => f.kind === 'video')
    if (images.length > 0) {
      // 图片 + 最多一个视频 → 实况照片（取第一个图片为主资产）
      const img = images[0]
      const live = videos[0] ?? null
      if (live) {
        usedVideos.add(live.relPath)
        livePairs++
      }
      assets.push({ image: img, liveVideo: live })
      // 同基名多余图片（如编辑变体）也独立入库为照片
      for (const extra of images.slice(1)) assets.push({ image: extra, liveVideo: null })
    } else if (videos.length > 0) {
      // 只有视频 → 普通视频资产
      for (const v of videos) assets.push({ image: v, liveVideo: null })
    }
  }

  scanProgress.livePairs = livePairs

  // ③ 逐资产提取元数据 + ④ 入库
  // RETURNING id：UPSERT 后直接拿到主键，同步 FTS 索引（见下方 upsertFts）
  const insert = db.prepare(`
    INSERT INTO assets (file_path, type, filename, date_taken, width, height, duration, orientation, gps_lat, gps_lon, live_video)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      type=excluded.type, filename=excluded.filename, date_taken=excluded.date_taken,
      width=excluded.width, height=excluded.height, duration=excluded.duration,
      orientation=excluded.orientation, gps_lat=excluded.gps_lat, gps_lon=excluded.gps_lon,
      live_video=excluded.live_video
    RETURNING id
  `)

  // FTS 同步：search_text 存小写文件名（搜索不区分大小写），date_taken 支持搜日期，
  // date_compact 为去标点日期（搜 "202409" 这类紧凑写法）。
  // INSERT OR REPLACE：按 rowid（=assets.id）覆盖旧行，增量重扫时索引保持一致。
  const upsertFts = db.prepare(
    `INSERT OR REPLACE INTO assets_fts(rowid, search_text, date_taken, date_compact)
     VALUES (?, lower(?), ?, ?)`,
  )

  const scanAll = db.transaction((rows: unknown[][]) => {
    for (const r of rows) {
      const { id } = insert.get(...r) as { id: number } // 数组展开为 11 个位置参数（注意：值不能是数组，better-sqlite3 会把数组值再展开）
      const dateTaken = r[3] as string
      upsertFts.run(id, r[2] as string, dateTaken, dateTaken.replace(/[^0-9a-zA-Z]/g, '')) // filename → search_text（lower 由 SQL 处理），dateTaken + 紧凑日期
    }
  })

  const batch: unknown[][] = []
  let i = 0
  for (const a of assets) {
    const absPath = a.image.absPath

    const isVideo = a.image.kind === 'video'
    // —— 图片：EXIF ——
    // —— 视频：ffprobe ——
    let type: 'photo' | 'video' | 'live' = a.image.kind === 'image' ? 'photo' : 'video'
    if (a.liveVideo) type = 'live'

    // —— 配对修正（本次修复重点）——
    // 已入库的文件：复用现有元数据（文件内容不变，iCloudPD 只读快照），
    // 但仍执行 UPSERT，让 type / live_video 按新的「目录+基名」配对结果修正，
    // 同时把之前因跨目录同名而漏掉的视频（现在是独立 video 或新 live）补进来。
    const exist = existingMeta.get(a.image.relPath)
    if (exist) {
      batch.push([
        a.image.relPath,
        type,
        a.image.fileName,
        exist.dateTaken,
        exist.width,
        exist.height,
        exist.duration,
        exist.orientation,
        exist.gpsLat,
        exist.gpsLon,
        a.liveVideo ? a.liveVideo.relPath : null,
      ])
      scanProgress.scannedFiles++
      if (batch.length >= 200) {
        scanAll(batch.splice(0))
      }
      i++
      continue
    }

    let dateTaken: string | null = null
    let width: number | null = null
    let height: number | null = null
    let duration: number | null = null
    let orientation: number | null = null
    let gpsLat: number | null = null
    let gpsLon: number | null = null

    if (isVideo) {
      const vm = await readVideoMeta(absPath)
      duration = vm.duration
      width = vm.width
      height = vm.height
      dateTaken = normalizeDate(vm.creationTime)
    } else {
      const im = await readImageMeta(absPath)
      dateTaken = normalizeDate(im.dateTaken)
      orientation = im.orientation
      gpsLat = im.gps?.lat ?? null
      gpsLon = im.gps?.lon ?? null
      width = im.width
      height = im.height
      // EXIF 拿不到尺寸时用 sharp 兜底（见 pipeline/thumbnails.ts 的 ensureSize）
    }

    // 时间兜底链：EXIF/ffprobe → 目录 YYYY/MM/DD → 文件修改时间
    if (!dateTaken) dateTaken = parseDateFromDir(a.image.relPath)
    if (!dateTaken) {
      try {
        const st = fs.statSync(absPath)
        dateTaken = st.mtime.toISOString()
      } catch {
        // 文件瞬时不可读（刚被移动/删除）：跳过本资产，下次重扫再试
        console.warn(`[scan] 跳过不可读文件: ${a.image.relPath}`)
        continue
      }
    }

    batch.push([
      a.image.relPath,
      type,
      a.image.fileName,
      dateTaken,
      width,
      height,
      duration,
      orientation,
      gpsLat,
      gpsLon,
      a.liveVideo ? a.liveVideo.relPath : null,
    ])
    scanProgress.scannedFiles++
    scanProgress.assetsFound++

    // 每 200 条批量提交一次（事务提升性能）
    if (batch.length >= 200) {
      scanAll(batch.splice(0))
    }
    i++
  }
  if (batch.length > 0) scanAll(batch)

  // ⑤ 把「缺少缩略图」的资产全部交给懒生成队列（队列本身有并发与去重）
  const rows = db
    .prepare(`SELECT id, file_path, type, live_video FROM assets WHERE thumb_status = 'pending'`)
    .all() as { id: number; file_path: string; type: string; live_video: string | null }[]

  for (const r of rows) {
    enqueueAsset({ id: r.id, relPath: r.file_path, type: r.type as 'photo' | 'video' | 'live', liveVideo: r.live_video })
  }

  // ⑥ 删除对账（P2+-1）：磁盘文件集合 vs DB 资产集合
  //    磁盘上已消失的文件 → 删资产记录 + FTS 索引 + 缩略图缓存，
  //    保证手动删文件/移动目录后照片墙不再显示"已不存在的图"。
  //    ⚠ 只删"遍历明确缺失"的文件：stat 瞬时失败的文件在 walkDir 阶段会被跳过，
  //    不会因 IO 抖动误删；实况视频缺失但主图还在的行不删（配对阶段已降级为 photo）。
  const diskPaths = new Set(files.map((f) => f.relPath))
  const dbRows = db.prepare(`SELECT id, file_path FROM assets`).all() as { id: number; file_path: string }[]
  const orphanIds: number[] = []
  const orphanSet = new Set<number>()
  for (const r of dbRows) {
    if (!diskPaths.has(r.file_path)) {
      orphanIds.push(r.id)
      orphanSet.add(r.id)
    }
  }
  if (orphanIds.length > 0) {
    const delTx = db.transaction((ids: number[]) => {
      for (const id of ids) deleteAssetById(id)
    })
    delTx(orphanIds)
    console.log(`[scan] 删除对账：清理 ${orphanIds.length} 个已不存在于磁盘的资产`)
  }

  // ⑦ 清理孤儿缩略图：缓存目录里 id 已不属于任何资产的 .webp（含 in-flight 竞态遗留）
  const validIds = new Set<number>()
  for (const r of dbRows) if (!orphanSet.has(r.id)) validIds.add(r.id)
  cleanOrphanThumbs(validIds)

  scanProgress.status = 'done'
  scanProgress.message = `扫描完成：共 ${scanProgress.assetsFound} 个媒体资产，${livePairs} 个实况照片`
  console.log(scanProgress.message)
  } catch (err) {
    // 容错：任何异常都收敛为可查询的 error 状态并上抛（/api/scan 的 catch 会接到）
    scanProgress.status = 'error'
    scanProgress.message = `扫描失败：${(err as Error).message}`
    console.error('[scan] failed:', err)
    throw err
  }
}


/**
 * 删除一个资产：DB 行 + FTS 索引 + 缩略图缓存（grid/detail/blur 三档）。
 * 供删除对账与后续客户端删除 API 复用。
 * 注意：缩略图队列 in-flight 恰好写出的文件会留一个孤儿 webp，
 * 由下次对账的 cleanOrphanThumbs 兜底清理。
 */
export function deleteAssetById(id: number): void {
  const db = getDb()
  for (const size of ['grid', 'detail', 'blur'] as const) {
    fs.rmSync(thumbCachePath(size, id), { force: true })
  }
  db.prepare(`DELETE FROM assets_fts WHERE rowid = ?`).run(id)
  db.prepare(`DELETE FROM assets WHERE id = ?`).run(id)
}

/**
 * 清理孤儿缩略图：cache/thumbs/<size>/ 下 id 已不存在于资产表的 .webp 文件。
 * 目录不存在（从未生成过该档）时静默跳过。
 */
function cleanOrphanThumbs(validIds: Set<number>): void {
  for (const size of ['grid', 'detail', 'blur'] as const) {
    const dir = path.join(config.cacheDir, 'thumbs', size)
    let names: string[] = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue // 目录不存在：还没生成过该档
    }
    for (const name of names) {
      if (!name.endsWith('.webp')) continue
      const id = Number(name.slice(0, -'.webp'.length))
      if (!Number.isInteger(id) || !validIds.has(id)) {
        fs.rmSync(path.join(dir, name), { force: true })
        console.log(`[scan] 清理孤儿缩略图: ${size}/${name}`)
      }
    }
  }
}