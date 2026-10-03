/**
 * 缩略图流水线（懒生成）
 *
 * 对标 iCloud 的「衍生图分级」思想：
 * - grid  ：320px WebP，覆盖网格任意缩放级别（iCloud 用 415px 档做同样的事）
 * - detail：1600px WebP，详情页大图
 * - poster：视频封面帧（ffmpeg 抽第 1 秒，再经 sharp 压成 320px WebP）
 *
 * 缓存路径：cache/thumbs/<size>/<assetId>.webp
 * 生成后把 assets 表对应 status 置为 done；失败置 error 并留日志。
 */
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { config } from '../config.js'
import { getDb } from '../db/index.js'
import { ffprobeJson, runFfmpeg } from '../ffmpeg.js'

/** 缩略图档位 */
export type ThumbSize = keyof typeof config.thumbSizes

/** 删除进程异常退出后遗留的临时帧；只处理本流水线命名且已超过 24 小时的文件。 */
export function cleanStaleTempFiles(maxAgeMs = 24 * 60 * 60 * 1000): void {
  const tempDir = path.join(config.cacheDir, 'tmp')
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(tempDir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[thumb] 无法读取临时目录 ${tempDir}:`, err)
    }
    return
  }

  const cutoff = Date.now() - maxAgeMs
  let removed = 0
  for (const entry of entries) {
    if (!entry.isFile() || !/^(?:frame|heic)_\d+_[a-z0-9]+\.png$/i.test(entry.name)) continue
    const tempPath = path.join(tempDir, entry.name)
    try {
      if (fs.statSync(tempPath).mtimeMs < cutoff) {
        fs.rmSync(tempPath)
        removed++
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[thumb] 清理临时文件失败 ${tempPath}:`, err)
      }
    }
  }
  if (removed > 0) console.info(`[thumb] 已清理 ${removed} 个过期临时帧`)
}

/** 缓存文件绝对路径，如 cache/thumbs/grid/123.webp */
export function thumbCachePath(size: ThumbSize, assetId: number): string {
  return path.join(config.cacheDir, 'thumbs', size, `${assetId}.webp`)
}

/**
 * 进行中的生成任务（in-flight 去重）：
 * 网格一次滚动会并发请求几十个缩略图，同一资产可能被多个请求/后台队列同时命中，
 * 并发写同一文件会损坏。用 Promise 缓存保证同一 (id, size) 全局只生成一次。
 */
const inFlight = new Map<string, Promise<string | null>>()

/**
 * 确保某资产具备指定档位的缩略图；已存在则直接返回路径。
 * 这是「懒生成」的核心入口：API 请求缩略图 → 未命中 → 现场生成。
 */
export function ensureThumbnail(assetId: number, size: ThumbSize): Promise<string | null> {
  const outPath = thumbCachePath(size, assetId)
  if (fs.existsSync(outPath)) return Promise.resolve(outPath)

  const key = `${assetId}:${size}`
  const pending = inFlight.get(key)
  if (pending) return pending // 已在生成 → 复用同一个 Promise

  const task = generate(assetId, size).finally(() => inFlight.delete(key))
  inFlight.set(key, task)
  return task
}

/** 实际生成逻辑（被 ensureThumbnail 去重包装） */
async function generate(assetId: number, size: ThumbSize): Promise<string | null> {
  const outPath = thumbCachePath(size, assetId)
  const db = getDb()
  const row = db
    .prepare(`SELECT file_path, type, width, height FROM assets WHERE id = ?`)
    .get(assetId) as { file_path: string; type: string; width: number | null; height: number | null } | undefined
  if (!row) return null

  const abs = path.join(config.libraryRoot, row.file_path)
  if (!fs.existsSync(abs)) return null

  const target = config.thumbSizes[size]
  const quality = config.thumbQuality[size]

  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true })

    if (row.type === 'video') {
      // —— 视频：ffmpeg 抽帧 → sharp 缩放 ——
      const framePath = await extractVideoFrame(abs, target)
      try {
        await sharp(framePath, { failOn: 'none' })
          .resize(target, target, { fit: 'inside', withoutEnlargement: true })
          .keepIccProfile()
          .webp({ quality })
          .toFile(outPath)
      } finally {
        // 修复（审查 P2-B5）：异常路径也必须删临时帧，否则 tmp 目录累积垃圾
        fs.rmSync(framePath, { force: true })
      }
    } else if (isHeic(row.file_path)) {
      // —— HEIC：sharp 官方预编译无 HEVC 解码器 → 用 ffmpeg(libheif) 解码为 PNG 再处理 ——
      const pngPath = await heicToPng(abs)
      try {
        await sharp(pngPath, { failOn: 'none' })
          .resize(target, target, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality })
          .toFile(outPath)
      } finally {
        fs.rmSync(pngPath, { force: true })
      }
    } else {
      // —— 其他图片（JPG/PNG/…）：sharp 直接解码 ——
      await sharp(abs, { failOn: 'none' }) // failOn: 容忍 EXIF 损坏的半坏图
        .rotate() // 应用 EXIF 方向（rotate 是链式方法，不是构造选项）
        .resize(target, target, { fit: 'inside', withoutEnlargement: true })
        .keepIccProfile()
        .webp({ quality })
        .toFile(outPath)
    }

    // 更新状态（detail 生成成功时也顺带记录宽高兜底）
    if (size === 'grid') db.prepare(`UPDATE assets SET thumb_status='done' WHERE id=?`).run(assetId)
    if (size === 'detail') db.prepare(`UPDATE assets SET detail_status='done' WHERE id=?`).run(assetId)
    return outPath
  } catch (err) {
    console.error(`[thumb] 生成失败 asset=${assetId} size=${size}`, (err as Error).message)
    // 兜底（审查 #7）：删除可能留下的 0 字节/半成品文件——否则 ensureThumbnail 的
    // existsSync 会把"存在"的坏文件永久当有效返回，修复后也不会重新生成
    fs.rmSync(outPath, { force: true })
    if (size === 'grid') db.prepare(`UPDATE assets SET thumb_status='error' WHERE id=?`).run(assetId)
    return null
  }
}

/** 判断是否为 HEIC/HEIF（需要 ffmpeg 解码） */
function isHeic(relPath: string): boolean {
  const ext = path.extname(relPath).toLowerCase()
  return ext === '.heic' || ext === '.heif'
}

/** 用 ffmpeg(libheif) 把 HEIC 解码为全尺寸 PNG 临时文件（sharp 再二次处理） */
async function heicToPng(absPath: string): Promise<string> {
  const tmp = path.join(config.cacheDir, 'tmp', `heic_${Date.now()}_${Math.random().toString(36).slice(2)}.png`)
  fs.mkdirSync(path.dirname(tmp), { recursive: true })
  try {
    await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-i', absPath, '-frames:v', '1', tmp])
    return tmp
  } catch (error) {
    fs.rmSync(tmp, { force: true })
    throw error
  }
}

/** 用 ffmpeg 抽取视频某一帧为临时 PNG（供 sharp 二次处理） */
async function extractVideoFrame(absPath: string, maxSize: number): Promise<string> {
  const tmp = path.join(config.cacheDir, 'tmp', `frame_${Date.now()}_${Math.random().toString(36).slice(2)}.png`)
  fs.mkdirSync(path.dirname(tmp), { recursive: true })
  const vf = `scale='min(${maxSize},iw)':'min(${maxSize},ih)':force_original_aspect_ratio=decrease`
  try {
    await runFfmpeg([
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      String(config.videoPosterSeek), // 跳过第 1 秒，避开黑场/片头（-ss 在 -i 前：快搜）
      '-i',
      absPath,
      '-vf',
      vf,
      '-frames:v',
      '1',
      tmp,
    ])
    return tmp
  } catch (error) {
    fs.rmSync(tmp, { force: true })
    throw error
  }
}

/**
 * 获取媒体原图/原视频的像素尺寸（EXIF 缺失时的兜底，供前端计算宽高比占位）。
 * 结果写入 assets 表并返回。
 *
 * 修复（审查 P1-②）：此函数必须返回「原文件尺寸」。
 * 旧实现曾用缩略图 metadata 回填，导致 assets.width/height 被污染成
 * 320/1600/32 这类缩略图尺寸（竖图会被当横图）。这里只读原文件：
 *   - sharp 可解码（JPG/PNG/…）→ sharp.metadata()
 *   - HEIC/HEIF（sharp 官方无 HEVC 解码器）→ ffprobe 兜底读分辨率
 */
export async function ensureSize(assetId: number): Promise<{ width: number; height: number } | null> {
  const db = getDb()
  const row = db.prepare(`SELECT file_path, width, height FROM assets WHERE id = ?`).get(assetId) as
    | { file_path: string; width: number | null; height: number | null }
    | undefined
  if (!row) return null
  if (row.width && row.height) return { width: row.width, height: row.height }

  const abs = path.join(config.libraryRoot, row.file_path)
  if (!fs.existsSync(abs)) return null

  // ① sharp 直接读（支持 JPG/PNG/GIF/WebP 等）
  try {
    const meta = await sharp(abs, { failOn: 'none' }).metadata()
    if (meta.width && meta.height) {
      db.prepare(`UPDATE assets SET width=?, height=? WHERE id=?`).run(meta.width, meta.height, assetId)
      return { width: meta.width, height: meta.height }
    }
  } catch {
    /* sharp 无法解码 → 走 ffprobe */
  }

  // ② ffprobe 兜底（HEIC/HEIF/罕见编码；BtbN full 版 ffprobe 带 libheif 可读）
  try {
    const size = await probeSize(abs)
    if (size) {
      db.prepare(`UPDATE assets SET width=?, height=? WHERE id=?`).run(size.width, size.height, assetId)
      return size
    }
  } catch {
    /* 忽略 */
  }
  return null
}

/** 用 ffprobe 读取媒体像素尺寸（HEIC 等 sharp 不支持格式的兜底） */
async function probeSize(absPath: string): Promise<{ width: number; height: number } | null> {
  try {
    const data = await ffprobeJson(absPath)
    const stream = data.streams?.find((s) => s.codec_type === 'video' || s.codec_type === 'image')
    if (stream?.width && stream?.height) return { width: stream.width, height: stream.height }
    return null
  } catch {
    return null
  }
}
