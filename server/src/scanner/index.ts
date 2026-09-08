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

/** 支持的媒体扩展名（小写） */
const IMAGE_EXTS = new Set(['.heic', '.heif', '.jpg', '.jpeg', '.png', '.gif', '.tiff'])
const VIDEO_EXTS = new Set(['.mov', '.mp4', '.m4v', '.avi'])

/** 扫描进度（内存态，简单够用） */
export const scanProgress = {
  status: 'idle' as 'idle' | 'scanning' | 'done' | 'error',
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
export async function runScan(): Promise<void> {
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

  // 已入库路径集合：增量续跑的核心（见函数头注释）
  const existing = new Set(
    (db.prepare(`SELECT file_path FROM assets`).all() as { file_path: string }[]).map((r) => r.file_path),
  )

  // ② 实况配对：按「配对基名」索引。
  //    配对基名 = 文件名去扩展名；对 *_HEVC.MOV 再去掉 _HEVC（与静止帧同名）。
  //    例：IMG_1234_HEVC.MOV → IMG_1234；IMG_1234.HEIC → IMG_1234
  const byPairKey = new Map<string, RawFile[]>()
  for (const f of files) {
    let key = baseName(f.fileName)
    if (f.kind === 'video' && key.endsWith('_HEVC')) key = key.slice(0, -'_HEVC'.length)
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

    // —— 断点续跑：已入库的文件直接跳过（iCloudPD 只读快照，文件不会变）——
    // 中断后重跑到这里会瞬间跨过已处理部分，只补未入库的新文件
    if (existing.has(a.image.relPath)) {
      scanProgress.scannedFiles++
      continue
    }

    const isVideo = a.image.kind === 'video'
    // —— 图片：EXIF ——
    // —— 视频：ffprobe ——
    let type: 'photo' | 'video' | 'live' = a.image.kind === 'image' ? 'photo' : 'video'
    if (a.liveVideo) type = 'live'

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
