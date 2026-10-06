/**
 * 目录扫描 + 实况配对 + 元数据入库（入库流水线）
 *
 * 流程：
 *  ① 递归遍历照片库，按扩展名分类 图片 / 视频
 *  ② 实况配对：同目录内配对基名相同的 图片+视频（对标 iCloudPD 的 suffix 命名策略）
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
import { beginThumbnailBatch, enqueueAsset, resetThumbnailProgress } from '../pipeline/queue.js'
import { thumbCachePath } from '../pipeline/thumbnails.js'

/** 支持的媒体扩展名（小写） */
const IMAGE_EXTS = new Set(['.heic', '.heif', '.jpg', '.jpeg', '.png', '.gif', '.tiff'])
const VIDEO_EXTS = new Set(['.mov', '.mp4', '.m4v', '.avi'])

/** 扫描进度（内存态，简单够用） */
export const scanProgress = {
  status: 'idle' as 'idle' | 'scanning' | 'done' | 'error',
  /** 本次扫描触发来源：手动 / 热监听 / 启动 */
  source: 'idle' as 'idle' | 'manual' | 'watcher' | 'startup',
  runId: 0,
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
  /** 源文件签名（F-03 修复）：size 字节数；mtimeMs 修改时间（毫秒，取整防抖动） */
  size: number
  mtimeMs: number
}

/** 已配对的资产：主资产 + 可选实况视频 */
interface PairedAsset {
  image: RawFile
  /** 配对的实况视频（可能无） */
  liveVideo: RawFile | null
}

/**
 * 递归遍历目录，保留已读文件并报告任何未能读取的目录。
 * 目录读取失败不会中断入库，但扫描结果不完整时不能用于删除对账。
 */
function walkDir(dir: string): { files: string[]; errors: string[] } {
  const result = { files: [] as string[], errors: [] as string[] }
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    result.errors.push(`${dir}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`)
    return result
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.isDirectory()) continue // 忽略隐藏目录；文件再由媒体扩展名筛选
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const child = walkDir(full)
      result.files.push(...child.files)
      result.errors.push(...child.errors)
    } else if (entry.isFile()) {
      result.files.push(full)
    }
  }
  return result
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
  scanProgress.runId++
  const db = getDb()
  scanProgress.status = 'scanning'
  scanProgress.message = '正在遍历目录…'
  scanProgress.totalFiles = 0
  scanProgress.scannedFiles = 0
  scanProgress.assetsFound = 0
  resetThumbnailProgress()

  try {
  // ① 收集所有媒体文件
  const traversal = walkDir(config.libraryRoot)
  const absPaths = traversal.files
  const traversalComplete = traversal.errors.length === 0
  if (!traversalComplete) {
    console.warn(`[scan] 目录遍历不完整，${traversal.errors.length} 个目录无法读取；本次将跳过删除对账`)
    for (const error of traversal.errors) console.warn(`[scan] 无法读取目录: ${error}`)
  }
  const allFiles: RawFile[] = []
  for (const abs of absPaths) {
    const fileName = path.basename(abs).toLowerCase()
    const ext =
      path.extname(abs).toLowerCase() ||
      (IMAGE_EXTS.has(fileName) || VIDEO_EXTS.has(fileName) ? fileName : '')
    if (!IMAGE_EXTS.has(ext) && !VIDEO_EXTS.has(ext)) continue
    // F-03 修复：收集源文件签名（size + mtimeMs）。stat 是轻量元信息查询（不读内容），
    // 全库 2 万文件总计约 1~2 秒；stat 失败（文件瞬时不可读）跳过本文件，watcher 会再触发。
    let size = 0
    let mtimeMs = 0
    try {
      const st = fs.statSync(abs)
      size = st.size
      mtimeMs = Math.trunc(st.mtimeMs)
    } catch {
      continue
    }
    allFiles.push({ relPath: path.relative(config.libraryRoot, abs), absPath: abs, fileName: path.basename(abs), kind: IMAGE_EXTS.has(ext) ? 'image' : 'video', size, mtimeMs })
  }

  // iCloudPD 常用 YYYY/MM/DD 目录结构。优先处理目录日期较新的媒体，
  // 让最新年份更早入库；同一天与无日期路径保持遍历顺序稳定。
  const prioritizedFiles = allFiles
    .map((file, index) => ({ file, index, directoryDate: parseDateFromDir(file.relPath) }))
    .sort((a, b) => {
      if (a.directoryDate && b.directoryDate) {
        return b.directoryDate.localeCompare(a.directoryDate) || a.index - b.index
      }
      if (a.directoryDate) return -1
      if (b.directoryDate) return 1
      return a.index - b.index
    })
    .map(({ file }) => file)

  // 测试/调试用：限制扫描数量（SCAN_LIMIT 环境变量），验证管线时避免全量等待
  const files = config.scanLimit > 0 ? prioritizedFiles.slice(0, config.scanLimit) : prioritizedFiles
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
    /** F-03 修复：上次扫描记录的源文件签名（新库为 null） */
    size: number | null
    mtimeMs: number | null
  }
  const existingMeta = new Map<string, ExistingMeta>()
  for (const r of db
    .prepare(
      `SELECT file_path, date_taken, width, height, duration, orientation, gps_lat, gps_lon, file_size, file_mtime FROM assets`,
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
    file_size: number | null
    file_mtime: number | null
  }[]) {
    existingMeta.set(r.file_path, {
      dateTaken: r.date_taken,
      width: r.width,
      height: r.height,
      duration: r.duration,
      orientation: r.orientation,
      gpsLat: r.gps_lat,
      gpsLon: r.gps_lon,
      size: r.file_size,
      mtimeMs: r.file_mtime,
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
  for (const [key, group] of byPairKey) {
    const images = group.filter((f) => f.kind === 'image')
    const videos = group.filter((f) => f.kind === 'video')
    if (images.length > 0) {
      // 图片 + 最多一个视频 → 实况照片（取第一个图片为主资产）
      const img = images[0]
      const live = videos[0] ?? null
      if (live) {
        livePairs++
      }
      assets.push({ image: img, liveVideo: live })
      // 同基名多余图片（如编辑变体）也独立入库为照片
      for (const extra of images.slice(1)) assets.push({ image: extra, liveVideo: null })
      // 额外视频不能静默丢弃；作为普通视频资产保留。
      for (const extra of videos.slice(1)) assets.push({ image: extra, liveVideo: null })
    } else if (videos.length > 0) {
      // 只有视频 → 普通视频资产
      for (const v of videos) assets.push({ image: v, liveVideo: null })
    }
  }

  scanProgress.livePairs = livePairs

  // ③ 逐资产提取元数据 + ④ 入库
  // RETURNING id：UPSERT 后直接拿到主键，同步 FTS 索引（见下方 upsertFts）
  // F-03 修复：DO UPDATE 同时写入 file_size/file_mtime（签名列）。
  const insert = db.prepare(`
    INSERT INTO assets (file_path, type, filename, date_taken, width, height, duration, orientation, gps_lat, gps_lon, live_video, file_size, file_mtime)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      type=excluded.type, filename=excluded.filename, date_taken=excluded.date_taken,
      width=excluded.width, height=excluded.height, duration=excluded.duration,
      orientation=excluded.orientation, gps_lat=excluded.gps_lat, gps_lon=excluded.gps_lon,
      live_video=excluded.live_video,
      file_size=excluded.file_size, file_mtime=excluded.file_mtime
    RETURNING id
  `)

  // FTS 同步：search_text 存小写文件名（搜索不区分大小写），date_taken 支持搜日期，
  // date_compact 为去标点日期（搜 "202409" 这类紧凑写法）。
  // INSERT OR REPLACE：按 rowid（=assets.id）覆盖旧行，增量重扫时索引保持一致。
  const upsertFts = db.prepare(
    `INSERT OR REPLACE INTO assets_fts(rowid, search_text, date_taken, date_compact)
     VALUES (?, lower(?), ?, ?)`,
  )

  // F-03 修复：源文件签名变化 → 缩略图状态重置 SQL（文件变了 = 新内容，清旧 error/ignored）
  const resetThumb = db.prepare(
    `UPDATE assets SET thumb_status='pending', thumb_error=NULL, thumb_ignored=0 WHERE id=?`,
  )
  // 复用分支里签名变化的 relPath（scanAll 里按 r[0] 匹配拿 id，事务内统一重置）
  const changedRelPaths = new Set<string>()
  const changedIds: number[] = []

  const scanAll = db.transaction((rows: unknown[][]) => {
    for (const r of rows) {
      const { id } = insert.get(...r) as { id: number } // 数组展开为 13 个位置参数（注意：值不能是数组，better-sqlite3 会把数组值再展开）
      const dateTaken = r[3] as string
      upsertFts.run(id, r[2] as string, dateTaken, dateTaken.replace(/[^0-9a-zA-Z]/g, '')) // filename → search_text（lower 由 SQL 处理），dateTaken + 紧凑日期
      // F-03 修复：同路径源文件签名变化 → 状态置 pending（旧缩略图缓存随后统一删除）
      if (changedRelPaths.has(r[0] as string)) {
        resetThumb.run(id)
        changedIds.push(id)
      }
    }
  })

  const batch: unknown[][] = []
  let i = 0
  for (const a of assets) {
    const absPath = a.image.absPath
    const fileCount = 1 + Number(a.liveVideo !== null)

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
      // F-03 修复：已有签名且与当前不一致 → 该资产缩略图缓存失效重生成（收集到 scanAll 统一重置）
      const changed =
        exist.size !== null && (exist.size !== a.image.size || exist.mtimeMs !== a.image.mtimeMs)
      if (changed) changedRelPaths.add(a.image.relPath)
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
        a.image.size,
        a.image.mtimeMs,
      ])
      scanProgress.scannedFiles += fileCount
      scanProgress.assetsFound++
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
        scanProgress.scannedFiles += fileCount
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
      a.image.size,
      a.image.mtimeMs,
    ])
    scanProgress.scannedFiles += fileCount
    scanProgress.assetsFound++

    // 每 200 条批量提交一次（事务提升性能）
    if (batch.length >= 200) {
      scanAll(batch.splice(0))
    }
    i++
  }
  if (batch.length > 0) scanAll(batch)

  // F-03 修复：源文件签名变化 → 删除旧缩略图缓存（grid + detail）。
  // 状态已在 scanAll 事务内置 pending；缓存不删则 ensureThumbnail 命中旧文件直接返回、
  // 永远不重新生成。deleteAssetById 会删缓存，但这里只删缓存、保留资产行。
  if (changedIds.length > 0) {
    for (const id of changedIds) {
      for (const size of ['grid', 'detail'] as const) {
        fs.rmSync(thumbCachePath(size, id), { force: true })
      }
    }
    console.log(`[scan] 源文件签名变化：${changedIds.length} 个资产的缩略图缓存已失效并重新入队`)
  }

  // ⑤ 删除对账（P2+-1）：磁盘文件集合 vs DB 资产集合
  //    磁盘上已消失的文件 → 删资产记录 + FTS 索引 + 缩略图缓存，
  //    保证手动删文件/移动目录后照片墙不再显示"已不存在的图"。
  //    ⚠ 只删"遍历明确缺失"的文件：stat 瞬时失败的文件在 walkDir 阶段会被跳过，
  //    不会因 IO 抖动误删；实况视频缺失但主图还在的行不删（配对阶段已降级为 photo）。
  // SCAN_LIMIT 只用于调试/验证，当前文件集合不完整时不能做删除对账。
  // 以配对后的主资产路径对账，而非原始媒体路径。实况 MOV 虽仍存在于磁盘，
  // 但已作为照片资产的 live_video 附件；若它此前曾以独立视频入库，应清掉旧记录。
  const assetPaths = new Set(assets.map((asset) => asset.image.relPath))
  const dbRows = db.prepare(`SELECT id, file_path FROM assets`).all() as { id: number; file_path: string }[]
  const orphanIds: number[] = []
  const orphanSet = new Set<number>()
  if (config.scanLimit <= 0 && traversalComplete) {
    for (const r of dbRows) {
      if (!assetPaths.has(r.file_path)) {
        orphanIds.push(r.id)
        orphanSet.add(r.id)
      }
    }
  }
  if (orphanIds.length > 0) {
    const delTx = db.transaction((ids: number[]) => {
      for (const id of ids) deleteAssetById(id)
    })
    delTx(orphanIds)
    console.log(`[scan] 删除对账：清理 ${orphanIds.length} 个已不存在于磁盘的资产`)
  }

  // ⑥ 清理孤儿缩略图：缓存目录里 id 已不属于任何资产的 .webp（含 in-flight 竞态遗留）
  const validIds = new Set<number>()
  for (const r of dbRows) if (!orphanSet.has(r.id)) validIds.add(r.id)
  cleanOrphanThumbs(validIds)

  // ⑦ 扫描完成且删除对账结束后，统计真实待处理/失败预览图并启动后台队列。
  // —— 缓存对账（F-07 系列修复）——
  // grid 缩略图已存在但 DB 仍 pending 的资产直接标记 done：ensureThumbnail 命中缓存时
  // 只返回文件、不写 DB，若状态曾丢失（早期生成成功但进程在写库前退出等）会永远卡在
  // pending → beginThumbnailBatch 的 preparing 永不收敛（前端 99% 转圈）。
  // 对账以缓存文件为权威补齐状态，再统计真正缺缓存的入队。
  const pendingThumbs = db
    .prepare(`SELECT id, file_path, type, live_video FROM assets WHERE thumb_status = 'pending'`)
    .all() as { id: number; file_path: string; type: string; live_video: string | null }[]
  const reconcileDone = db.prepare(
    `UPDATE assets SET thumb_status='done', thumb_error=NULL WHERE id=? AND thumb_status='pending'`,
  )
  let reconciled = 0
  for (const r of pendingThumbs) {
    if (fs.existsSync(thumbCachePath('grid', r.id))) {
      reconcileDone.run(r.id)
      reconciled++
    }
  }
  if (reconciled > 0) {
    console.log(`[scan] 缓存对账：${reconciled} 个资产缩略图已存在，状态补记为 done（未入队）`)
  }
  const realPendingThumbs = db
    .prepare(`SELECT id, file_path, type, live_video FROM assets WHERE thumb_status = 'pending'`)
    .all() as { id: number; file_path: string; type: string; live_video: string | null }[]
  beginThumbnailBatch()
  for (const r of realPendingThumbs) {
    enqueueAsset({ id: r.id, relPath: r.file_path, type: r.type as 'photo' | 'video' | 'live', liveVideo: r.live_video })
  }

  scanProgress.status = 'done'
  scanProgress.message = traversalComplete
    ? `扫描完成：共 ${scanProgress.assetsFound} 个媒体资产，${livePairs} 个实况照片`
    : `扫描完成但目录遍历不完整：共 ${scanProgress.assetsFound} 个媒体资产，${livePairs} 个实况照片；已跳过删除对账`
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
 * 删除一个资产：DB 行 + FTS 索引 + 缩略图缓存。
 * 供删除对账与后续客户端删除 API 复用。
 * 注意：缩略图队列 in-flight 恰好写出的文件会留一个孤儿 webp，
 * 由下次对账的 cleanOrphanThumbs 兜底清理。
 */
export function deleteAssetById(id: number): void {
  const db = getDb()
  for (const size of ['grid', 'detail'] as const) {
    fs.rmSync(thumbCachePath(size, id), { force: true })
  }
  db.prepare(`DELETE FROM assets_fts WHERE rowid = ?`).run(id)
  db.prepare(`DELETE FROM assets WHERE id = ?`).run(id)
}

/**
 * 清理废弃的 blur 缓存和孤儿缩略图：cache/thumbs/<size>/ 下 id 已不存在于资产表的 .webp 文件。
 * 目录不存在（从未生成过该档）时静默跳过。
 */
function cleanOrphanThumbs(validIds: Set<number>): void {
  const legacyBlurDir = path.join(config.cacheDir, 'thumbs', 'blur')
  try {
    fs.rmSync(legacyBlurDir, { recursive: true, force: true })
  } catch (err) {
    console.warn(`[scan] 清理已废弃的 blur 缩略图缓存失败: ${legacyBlurDir}`, err)
  }

  for (const size of ['grid', 'detail'] as const) {
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