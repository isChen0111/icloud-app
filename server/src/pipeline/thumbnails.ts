/**
 * 缩略图流水线（懒生成）
 *
 * 对标 iCloud 的「衍生图分级」思想：
 * - grid  ：320px WebP，覆盖网格任意缩放级别（iCloud 用 415px 档做同样的事）
 * - detail：1600px WebP，详情页大图
 * - blur  ：32px 模糊 WebP，滚动时的即时占位
 * - poster：视频封面帧（ffmpeg 抽第 1 秒，再经 sharp 压成 320px WebP）
 *
 * 缓存路径：cache/thumbs/<size>/<assetId>.webp
 * 生成后把 assets 表对应 status 置为 done；失败置 error 并留日志。
 */
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import ffmpeg from 'fluent-ffmpeg'
import ffmpegPath from 'ffmpeg-static'
import { config } from '../config.js'
import { getDb } from '../db/index.js'

// 把 ffmpeg 二进制路径交给 fluent-ffmpeg（Windows 上必须显式指定）
if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath)

/** 缩略图档位 */
export type ThumbSize = keyof typeof config.thumbSizes

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
      await sharp(framePath, { failOn: 'none' })
        .resize(target, target, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality })
        .toFile(outPath)
      fs.rmSync(framePath, { force: true })
    } else if (isHeic(row.file_path)) {
      // —— HEIC：sharp 官方预编译无 HEVC 解码器 → 用 ffmpeg(libheif) 解码为 JPEG 再处理 ——
      const jpegPath = await heicToJpeg(abs)
      try {
        await sharp(jpegPath, { failOn: 'none' })
          .resize(target, target, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality })
          .toFile(outPath)
      } finally {
        fs.rmSync(jpegPath, { force: true })
      }
    } else {
      // —— 其他图片（JPG/PNG/…）：sharp 直接解码 ——
      await sharp(abs, { failOn: 'none', rotate: true }) // rotate: 应用 EXIF 方向
        .resize(target, target, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality })
        .toFile(outPath)
    }

    // 更新状态（detail 生成成功时也顺带记录宽高兜底）
    if (size === 'grid') db.prepare(`UPDATE assets SET thumb_status='done' WHERE id=?`).run(assetId)
    if (size === 'detail') db.prepare(`UPDATE assets SET detail_status='done' WHERE id=?`).run(assetId)
    return outPath
  } catch (err) {
    console.error(`[thumb] 生成失败 asset=${assetId} size=${size}`, (err as Error).message)
    if (size === 'grid') db.prepare(`UPDATE assets SET thumb_status='error' WHERE id=?`).run(assetId)
    return null
  }
}

/** 判断是否为 HEIC/HEIF（需要 ffmpeg 解码） */
function isHeic(relPath: string): boolean {
  const ext = path.extname(relPath).toLowerCase()
  return ext === '.heic' || ext === '.heif'
}

/** 用 ffmpeg(libheif) 把 HEIC 解码为全尺寸 JPEG 临时文件（sharp 再二次处理） */
function heicToJpeg(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const tmp = path.join(config.cacheDir, 'tmp', `heic_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`)
    fs.mkdirSync(path.dirname(tmp), { recursive: true })
    ffmpeg(absPath)
      .outputOptions(['-frames:v', '1', '-q:v', '3']) // q:v 3 ≈ 高质量 JPEG
      .output(tmp)
      .on('end', () => resolve(tmp))
      .on('error', (err) => reject(err))
      .run()
  })
}

/** 用 ffmpeg 抽取视频某一帧为临时 PNG（供 sharp 二次处理） */
function extractVideoFrame(absPath: string, maxSize: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const tmp = path.join(config.cacheDir, 'tmp', `frame_${Date.now()}_${Math.random().toString(36).slice(2)}.png`)
    fs.mkdirSync(path.dirname(tmp), { recursive: true })
    ffmpeg(absPath)
      .seekInput(config.videoPosterSeek) // 跳过第 1 秒，避开黑场/片头
      .outputOptions([`-vf`, `scale='min(${maxSize},iw)':'min(${maxSize},ih)':force_original_aspect_ratio=decrease`, '-frames:v', '1'])
      .output(tmp)
      .on('end', () => resolve(tmp))
      .on('error', (err) => reject(err))
      .run()
  })
}

/**
 * 获取图片像素尺寸（EXIF 缺失时的兜底，供前端计算宽高比占位）。
 * 结果写入 assets 表并返回。
 */
export async function ensureSize(assetId: number): Promise<{ width: number; height: number } | null> {
  const db = getDb()
  const row = db.prepare(`SELECT file_path, width, height FROM assets WHERE id = ?`).get(assetId) as
    | { file_path: string; width: number | null; height: number | null }
    | undefined
  if (!row) return null
  if (row.width && row.height) return { width: row.width, height: row.height }
  try {
    const meta = await sharp(path.join(config.libraryRoot, row.file_path), { failOn: 'none' }).metadata()
    if (meta.width && meta.height) {
      db.prepare(`UPDATE assets SET width=?, height=? WHERE id=?`).run(meta.width, meta.height, assetId)
      return { width: meta.width, height: meta.height }
    }
  } catch {
    /* 忽略 */
  }
  return null
}
