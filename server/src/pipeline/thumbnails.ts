/**
 * 缩略图流水线（懒生成）
 *
 * 对标 iCloud 的「衍生图分级」思想：
 * - grid  ：320px WebP，覆盖网格任意缩放级别（iCloud 用 415px 档做同样的事）
 * - detail：1600px WebP，详情页大图
 * - poster：视频封面帧（ffmpeg 抽第 1 秒，再经 sharp 压成 320px WebP）
 *
 * 缓存路径：cache/thumbs/<size>/<assetId>.webp
 * 生成后把 assets 表对应 status 置为 done；网格预览图失败时持久化原因。
 *
 * 库归属（审查 C-02）：`getDb()` 返回的是「永不失效」的 Proxy，每次 `.prepare()` 都解析到
 * **当前**激活库。生成一张缩略图要几百毫秒到几十秒（视频抽帧更久），期间用户切库的话，
 * 结尾那几条 UPDATE 就会写到新库的同 id 资产上。所以 generate/ensureSize 都在开始时
 * 快照 `config.dbPath`，写库前重新比对，不一致就整段放弃（一条 UPDATE 都不执行）。
 */
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import type { Sharp } from 'sharp'
import { config } from '../config.js'
import { getDb } from '../db/index.js'
import { resolveInsideRoot } from '../utils/path.js'
import { ffprobeJson, runFfmpeg, runFfmpegToBuffer } from '../ffmpeg.js'

sharp.concurrency(2)

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
 * 缓存是否可用（R-17）。
 *
 * 只判 `existsSync` 不够：断电 / 强杀 / 磁盘满会留下 0 字节或截断的 .webp，
 * 而 `sharp(...).toFile()` 是直接写目标路径的非原子操作。
 * 这种坏文件一旦存在就被永久当有效 —— 前端 <img> 显示破图，点「重试」也命中缓存直接返回。
 * 因此要求 size > 0；stat 失败（并发删除等）同样视为不可用。
 */
export function isCacheUsable(filePath: string): boolean {
  try {
    return fs.statSync(filePath).size > 0
  } catch {
    return false
  }
}

/**
 * 原子写缩略图（R-17）：先写同目录临时文件再 rename 到目标路径。
 *
 * rename 在同一分区上是原子的 —— 中途断电只会留下 .tmp 垃圾（无人引用），
 * 不会出现「目标路径存在但内容不完整」的窗口。
 * Windows 上目标文件被其他进程占用时 rename 会 EPERM：删掉目标再试一次，
 * 仍失败则清理临时文件并抛出（调用方 catch 会删目标路径，见 generate 的兜底）。
 */
async function writeAtomicWebp(pipeline: Sharp, outPath: string): Promise<void> {
  const tmpPath = `${outPath}.${process.pid}-${Math.random().toString(36).slice(2, 10)}.tmp`
  await pipeline.toFile(tmpPath)
  try {
    fs.renameSync(tmpPath, outPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EBUSY' || code === 'EEXIST') {
      fs.rmSync(outPath, { force: true })
      try {
        fs.renameSync(tmpPath, outPath)
        return
      } catch {
        /* 落到下方统一清理 */
      }
    }
    fs.rmSync(tmpPath, { force: true })
    throw err
  }
}

/**
 * 进行中的生成任务（in-flight 去重）：
 * 网格一次滚动会并发请求几十个缩略图，同一资产可能被多个请求/后台队列同时命中，
 * 并发写同一文件会损坏。用 Promise 缓存保证同一 (id, size) 全局只生成一次。
 *
 * R-07 修复（2026-10-28）：key 必须带库标识。资产 id 是每个库各自从 1 自增的，
 * lib1 的 id=42 和 lib6 的 id=42 是两张毫不相干的照片；切库后若沿用同一个 key，
 * 新库会复用旧库在途的 Promise → 回来的路径指向旧库缓存文件（照片墙上串图），
 * 旧任务 finally 里的 delete 还可能误删新库刚建立的那条。
 * 用 config.dbPath 做前缀最省事：切库时它必然变化，天然隔离。
 */
const inFlight = new Map<string, Promise<string | null>>()

/**
 * in-flight 去重键：库标识 + 资产 id + 档位。
 *
 * 抽出为独立函数是为了让单测能直接验证「不同库的同 id 不共键」（R-07），
 * 生产代码统一经 ensureThumbnail 使用，不直接调用。
 */
export function inFlightKey(assetId: number, size: ThumbSize, dbPath: string = config.dbPath): string {
  return `${dbPath}|${assetId}:${size}`
}

/**
 * 确保某资产具备指定档位的缩略图；已存在则直接返回路径。
 * 这是「懒生成」的核心入口：API 请求缩略图 → 未命中 → 现场生成。
 *
 * 修复（F-07 系列）：grid 档且用户已忽略（thumb_status='error' + thumb_ignored=1）
 * 的任务不再自动重试——用户已明确放弃该图，重复尝试只会白耗 ffmpeg 并反复失败。
 * 手动「重试」会先把状态置 pending + ignored=0，走正常流程绕过此判断；detail 档不受影响。
 */
export function ensureThumbnail(
  assetId: number,
  size: ThumbSize,
  priority: 'interactive' | 'background' = 'interactive',
): Promise<string | null> {
  const outPath = thumbCachePath(size, assetId)
  // R-17：size > 0 才算命中，0 字节/截断的坏缓存视为未生成（否则永久破图且重试无效）
  if (isCacheUsable(outPath)) return Promise.resolve(outPath)
  if (size === 'grid' && isThumbIgnored(assetId)) return Promise.resolve(null)

  // 库标识 + 资产 id + 档位（见上方 inFlight 注释：跨库绝不能共用同一个 key）
  const key = inFlightKey(assetId, size)
  const pending = inFlight.get(key)
  if (pending) return pending // 已在生成 → 复用同一个 Promise

  const task = generate(assetId, size, priority).finally(() => inFlight.delete(key))
  inFlight.set(key, task)
  return task
}

/** 该资产的网格缩略图是否已被用户忽略（仅 error 状态下的忽略标记生效） */
function isThumbIgnored(assetId: number): boolean {
  const row = getDb()
    .prepare(`SELECT thumb_ignored FROM assets WHERE id = ? AND thumb_status = 'error'`)
    .get(assetId) as { thumb_ignored: number } | undefined
  return row?.thumb_ignored === 1
}

/** 实际生成逻辑（被 ensureThumbnail 去重包装） */
async function generate(
  assetId: number,
  size: ThumbSize,
  priority: 'interactive' | 'background',
): Promise<string | null> {
  const outPath = thumbCachePath(size, assetId)
  const db = getDb()
  /** 本次任务开始时所属的库（写库前必须仍等于当前库，见文件头「库归属」） */
  const ownerDbPath = config.dbPath
  const row = db
    .prepare(`SELECT file_path, type, width, height, duration FROM assets WHERE id = ?`)
    .get(assetId) as
    | {
        file_path: string
        type: string
        width: number | null
        height: number | null
        duration: number | null
      }
    | undefined
  if (!row) return null

  const abs = resolveInsideRoot(config.libraryRoot, row.file_path)
  if (!abs) return null

  const target = config.thumbSizes[size]
  const quality = config.thumbQuality[size]

  try {
    if (!fs.existsSync(abs)) throw new Error('源文件不存在或无法访问')
    fs.mkdirSync(path.dirname(outPath), { recursive: true })

    if (row.type === 'video') {
      // —— 视频：ffmpeg 抽帧 → sharp 缩放（帧走 JPEG 管道，不落临时文件）——
      const frame = await videoFrameSource(abs, target, row.duration, priority)
      try {
        await writeAtomicWebp(
          frame.image
            .resize(target, target, { fit: 'inside', withoutEnlargement: true })
            .keepIccProfile()
            .webp({ quality }),
          outPath,
        )
      } finally {
        // 兜底路径会产生临时帧，管道路径 release 是空操作
        frame.release()
      }
    } else if (isHeic(row.file_path)) {
      // —— HEIC：sharp 官方预编译无 HEVC 解码器 → 用 ffmpeg(libheif) 解码，JPEG 管道直送 sharp ——
      const frame = await heicFrameSource(abs, priority)
      try {
        await writeAtomicWebp(
          frame.image
            .resize(target, target, { fit: 'inside', withoutEnlargement: true })
            .webp({ quality }),
          outPath,
        )
      } finally {
        frame.release()
      }
    } else {
      // —— 其他图片（JPG/PNG/…）：sharp 直接解码 ——
      await writeAtomicWebp(
        sharp(abs, { failOn: 'none' }) // failOn: 容忍 EXIF 损坏的半坏图
          .rotate() // 应用 EXIF 方向（rotate 是链式方法，不是构造选项）
          .resize(target, target, { fit: 'inside', withoutEnlargement: true })
          .keepIccProfile()
          .webp({ quality }),
        outPath,
      )
    }

    // 写库前重新校验库归属：切库了就直接放弃，一条 UPDATE 都不执行。
    // 缩略图文件写的是旧库 cacheDir，对新库那张同 id 的照片没有任何意义。
    if (config.dbPath !== ownerDbPath) {
      console.warn(`[thumb] 生成期间切换了照片库，放弃写库 asset=${assetId} size=${size}`)
      return null
    }
    // 更新状态（detail 生成成功时也顺带记录宽高兜底）
    if (size === 'grid') {
      // 先查旧状态（必须在 UPDATE 之前）：失败项重新生成成功 → 打自愈日志，解释失败清单里「项消失」的原因
      const prev = db
        .prepare(`SELECT thumb_status, thumb_error FROM assets WHERE id = ? AND (thumb_status = 'error' OR thumb_error IS NOT NULL)`)
        .get(assetId) as { thumb_status: string; thumb_error: string | null } | undefined
      // 修复（F-07 系列）：失败保留 ignored——不无条件清 0，避免「忽略 → 被浏览重试失败 → 弹回失败」反复横跳
      db.prepare(`UPDATE assets SET thumb_status='done', thumb_error=NULL WHERE id=?`).run(assetId)
      if (prev) {
        console.log(`[thumb] 失败项已恢复 asset=${assetId}（重新生成成功，原错误: ${(prev.thumb_error ?? '').slice(0, 120)}）`)
      }
    }
    if (size === 'detail') db.prepare(`UPDATE assets SET detail_status='done' WHERE id=?`).run(assetId)
    return outPath
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[thumb] 生成失败 asset=${assetId} size=${size}`, message)
    // 兜底（审查 #7 / R-17）：失败时清掉目标路径上的残留。
    // 写入已改原子（先 .tmp 再 rename），正常失败不会留下半成品；但这里仍要删——
    // 目标路径可能躺着上次遗留的坏文件（截断但长度非 0），留着会被 isCacheUsable 判为可用
    fs.rmSync(outPath, { force: true })
    if (size === 'grid' && config.dbPath === ownerDbPath) {
      // grid 失败持久化 thumb_status='error' → 进失败清单（浮层可忽略/重试）。
      // 修复（F-07 系列）：不再覆盖 thumb_ignored——忽略状态由用户显式管理，失败不清除
      db.prepare(`UPDATE assets SET thumb_status='error', thumb_error=? WHERE id=?`)
        .run(message.slice(0, 1000), assetId)
    }
    // detail 档失败有意「不进失败清单」：失败清单只管理网格预览图（照片墙入口）。
    // detail_status 保持 pending，下次进详情页会重新懒生成；grid 已成功的资产不受影响。
    return null
  }
}

/**
 * 一次缩略图生成的「帧来源」。
 * 管道模式（JPEG buffer）不落任何临时文件，release 是空操作；
 * 回落到 PNG 落盘兜底时才需要删文件。
 */
interface FrameSource {
  image: Sharp
  release: () => void
}

/**
 * JPEG 中间帧质量。
 * 实测 `-q:v 1` 与 `-q:v 2` 输出的字节数完全一致（mjpeg 量化表被 clamp 到同一档），
 * 所以取 2，不要再往 1 试。
 */
const FRAME_JPEG_QUALITY = '2'

/** 判断是否为 HEIC/HEIF（需要 ffmpeg 解码） */
function isHeic(relPath: string): boolean {
  const ext = path.extname(relPath).toLowerCase()
  return ext === '.heic' || ext === '.heif'
}

/** 用 ffmpeg(libheif) 把 HEIC 解码为全尺寸 PNG 临时文件（sharp 再二次处理） */
async function heicToPng(absPath: string, priority: 'interactive' | 'background'): Promise<string> {
  const tmp = path.join(config.cacheDir, 'tmp', `heic_${Date.now()}_${Math.random().toString(36).slice(2)}.png`)
  fs.mkdirSync(path.dirname(tmp), { recursive: true })
  try {
    await runFfmpeg([
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-threads',
      priority === 'background' ? '1' : '2',
      '-i',
      absPath,
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
 * HEIC → JPEG buffer（管道，不落盘）。
 *
 * 为什么不写字：解码本身只要约 0.3s，旧实现那 3s 里 90% 花在把全尺寸帧编码成 PNG
 * 并写 10~12MB 临时文件、再由 sharp 读回来。改成 JPEG 管道后单张 3.2s → 0.35s。
 *
 * 注意：这批 HEIC 内部是多路 HEVC 子图，ffmpeg 用 complex filtergraph 组装主图，
 * 所以**不能**加 `-vf`（会报 Simple and complex filtering cannot be used together），
 * 也**不能**加 `-map 0:v:0`（拿到的是 512×512 缩略图子图）。缩放一律交给 sharp。
 */
async function heicToJpegBuffer(absPath: string, priority: 'interactive' | 'background'): Promise<Buffer | null> {
  try {
    const buf = await runFfmpegToBuffer([
      '-hide_banner',
      '-loglevel',
      'error',
      '-threads',
      priority === 'background' ? '1' : '2',
      '-i',
      absPath,
      '-frames:v',
      '1',
      '-q:v',
      FRAME_JPEG_QUALITY,
      '-an',
      '-f',
      'image2pipe',
      '-c:v',
      'mjpeg',
      '-',
    ])
    if (buf.length === 0) throw new Error('ffmpeg 未输出任何帧数据')
    return buf
  } catch (error) {
    // 管道失败（编码器不支持 / 输出被截断 / 文件损坏）→ 交给 PNG 落盘老路，
    // 保证「慢但能出图」，不让一张缩略图因为优化路径失败而进失败清单。
    console.warn(
      `[thumb] HEIC JPEG 管道失败，回落 PNG 落盘: ${path.basename(absPath)}（${(error as Error).message.slice(0, 120)}）`,
    )
    return null
  }
}

/** HEIC 帧来源：优先 JPEG 管道，失败回落 PNG 临时文件 */
async function heicFrameSource(absPath: string, priority: 'interactive' | 'background'): Promise<FrameSource> {
  const buf = await heicToJpegBuffer(absPath, priority)
  if (buf) return { image: sharp(buf, { failOn: 'none' }), release: () => {} }
  const pngPath = await heicToPng(absPath, priority)
  return { image: sharp(pngPath, { failOn: 'none' }), release: () => fs.rmSync(pngPath, { force: true }) }
}

/** 用 ffmpeg 抽取视频某一帧为临时 PNG（供 sharp 二次处理；现已降级为兜底路径） */
async function extractVideoFrame(
  absPath: string,
  maxSize: number,
  duration: number | null,
  priority: 'interactive' | 'background',
): Promise<string> {
  const tmp = path.join(config.cacheDir, 'tmp', `frame_${Date.now()}_${Math.random().toString(36).slice(2)}.png`)
  fs.mkdirSync(path.dirname(tmp), { recursive: true })
  const vf = `scale='min(${maxSize},iw)':'min(${maxSize},ih)':force_original_aspect_ratio=decrease`
  const seek =
    duration !== null && Number.isFinite(duration) && duration > 0
      ? Math.min(config.videoPosterSeek, duration / 2)
      : config.videoPosterSeek

  async function extractAt(seconds: number): Promise<void> {
    await runFfmpeg([
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      String(seconds), // -ss 在 -i 前：快搜
      '-threads',
      priority === 'background' ? '1' : '2',
      '-i',
      absPath,
      '-vf',
      vf,
      '-frames:v',
      '1',
      tmp,
    ])
    if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) {
      throw new Error(`No video frame available at ${seconds}s`)
    }
  }

  try {
    try {
      await extractAt(seek)
    } catch (error) {
      if (seek === 0) throw error
      fs.rmSync(tmp, { force: true })
      await extractAt(0)
    }
    return tmp
  } catch (error) {
    fs.rmSync(tmp, { force: true })
    throw error
  }
}

/**
 * 视频抽帧 → JPEG buffer（管道）。
 * 与 HEIC 不同，视频可以放心用 `-vf scale`，所以缩放放在 ffmpeg 里做，
 * 送进 sharp 的就已经是目标尺寸附近的小图（约 0.1MB），sharp 只负责压 webp。
 */
async function extractVideoFrameJpeg(
  absPath: string,
  maxSize: number,
  duration: number | null,
  priority: 'interactive' | 'background',
): Promise<Buffer | null> {
  const vf = `scale='min(${maxSize},iw)':'min(${maxSize},ih)':force_original_aspect_ratio=decrease`
  const seek =
    duration !== null && Number.isFinite(duration) && duration > 0
      ? Math.min(config.videoPosterSeek, duration / 2)
      : config.videoPosterSeek

  async function pipeAt(seconds: number): Promise<Buffer> {
    const buf = await runFfmpegToBuffer([
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      String(seconds), // -ss 在 -i 前：快搜
      '-threads',
      priority === 'background' ? '1' : '2',
      '-i',
      absPath,
      '-vf',
      vf,
      '-frames:v',
      '1',
      '-q:v',
      FRAME_JPEG_QUALITY,
      '-an',
      '-f',
      'image2pipe',
      '-c:v',
      'mjpeg',
      '-',
    ])
    if (buf.length === 0) throw new Error(`No video frame available at ${seconds}s`)
    return buf
  }

  try {
    try {
      return await pipeAt(seek)
    } catch (error) {
      if (seek === 0) throw error
      return await pipeAt(0)
    }
  } catch (error) {
    console.warn(
      `[thumb] 视频抽帧 JPEG 管道失败，回落 PNG 落盘: ${path.basename(absPath)}（${(error as Error).message.slice(0, 120)}）`,
    )
    return null
  }
}

/** 视频帧来源：优先 JPEG 管道，失败回落 PNG 临时文件 */
async function videoFrameSource(
  absPath: string,
  maxSize: number,
  duration: number | null,
  priority: 'interactive' | 'background',
): Promise<FrameSource> {
  const buf = await extractVideoFrameJpeg(absPath, maxSize, duration, priority)
  if (buf) return { image: sharp(buf, { failOn: 'none' }), release: () => {} }
  const pngPath = await extractVideoFrame(absPath, maxSize, duration, priority)
  return { image: sharp(pngPath, { failOn: 'none' }), release: () => fs.rmSync(pngPath, { force: true }) }
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
  /** 任务开始时所属的库；await 之后写库前必须仍一致（审查 C-02，同 generate） */
  const ownerDbPath = config.dbPath
  const ownsLibrary = (): boolean => config.dbPath === ownerDbPath
  const row = db.prepare(`SELECT file_path, width, height FROM assets WHERE id = ?`).get(assetId) as
    | { file_path: string; width: number | null; height: number | null }
    | undefined
  if (!row) return null
  if (row.width && row.height) return { width: row.width, height: row.height }

  const abs = resolveInsideRoot(config.libraryRoot, row.file_path)
  if (!abs || !fs.existsSync(abs)) return null

  // ① sharp 直接读（支持 JPG/PNG/GIF/WebP 等）
  try {
    const meta = await sharp(abs, { failOn: 'none' }).metadata()
    if (meta.width && meta.height) {
      if (ownsLibrary()) {
        db.prepare(`UPDATE assets SET width=?, height=? WHERE id=?`).run(meta.width, meta.height, assetId)
      }
      return { width: meta.width, height: meta.height }
    }
  } catch {
    /* sharp 无法解码 → 走 ffprobe */
  }

  // ② ffprobe 兜底（HEIC/HEIF/罕见编码；BtbN full 版 ffprobe 带 libheif 可读）
  try {
    const size = await probeSize(abs)
    if (size) {
      if (ownsLibrary()) {
        db.prepare(`UPDATE assets SET width=?, height=? WHERE id=?`).run(size.width, size.height, assetId)
      }
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
