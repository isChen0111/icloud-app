/**
 * 元数据提取
 *
 * 从媒体文件中读取「拍摄时间 / 尺寸 / 方向 / GPS / 时长」。
 * - 图片：exifr 解析 EXIF（支持 HEIC/JPEG/PNG）。部分文件 EXIF 缺失时，
 *   用 sharp 读像素尺寸兜底。
 * - 视频：ffprobe（经 fluent-ffmpeg）读取时长与分辨率，并从元数据中找
 *   creation_time；找不到就用目录日期/文件时间兜底。
 */
import exifr from 'exifr'
import ffmpeg from 'fluent-ffmpeg'
import ffmpegPath from 'ffmpeg-static'
import path from 'node:path'

// fluent-ffmpeg 的 ffprobe 从环境变量 FFPROBE_PATH 找二进制；
// ffmpeg-static 只自带 ffmpeg，我们把同目录的 ffprobe.exe 指给它们。
if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath)
  process.env.FFPROBE_PATH = path.join(path.dirname(ffmpegPath), 'ffprobe.exe')
}

/** 从目录 YYYY/MM/DD 解析日期（iCloudPD 默认结构），失败返回 null */
export function parseDateFromDir(filePath: string): string | null {
  // 例：2025/02/17/IMG_1234.HEIC → ['2025','02','17']
  const m = filePath.match(/(\d{4})\/(\d{2})\/(\d{2})\//)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (y < 1970 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return `${m[1]}-${m[2]}-${m[3]}T00:00:00+08:00`
}

/** 图片元数据（EXIF 提取结果） */
export interface ImageMeta {
  /** 拍摄时间（ISO8601 字符串）或 null */
  dateTaken: string | null
  /** EXIF 方向 1~8 */
  orientation: number | null
  /** 像素尺寸（可能为 null，此时需 sharp 兜底） */
  width: number | null
  height: number | null
  gps: { lat: number; lon: number } | null
}

/** 度分秒数组（EXIF 的 GPS 格式）→ 十进制度数。例：DMS [50,30,10] → 50.5028 */
function dmsToDecimal(v: unknown): number | null {
  if (typeof v === 'number') return v
  if (Array.isArray(v) && v.length === 3) {
    const [d, m, s] = v.map(Number)
    if ([d, m, s].some((n) => Number.isNaN(n))) return null
    return d + m / 60 + s / 3600
  }
  return null
}

/** 解析图片 EXIF。传入绝对路径。 */
export async function readImageMeta(absPath: string): Promise<ImageMeta> {
  try {
    const exif = await exifr.parse(absPath, {
      pick: ['DateTimeOriginal', 'CreateDate', 'Orientation', 'ImageWidth', 'ImageHeight', 'GPSLatitude', 'GPSLongitude'],
      // 不翻译值：Orientation 返回数字 1~8（默认会转成 "Rotate 90 CW" 这种字符串，前端用不了）
      translateValues: false,
    })
    const lat = dmsToDecimal(exif?.GPSLatitude)
    const lon = dmsToDecimal(exif?.GPSLongitude)
    return {
      dateTaken: exif?.DateTimeOriginal ?? exif?.CreateDate ?? null,
      orientation: exif?.Orientation ?? null,
      width: exif?.ImageWidth ?? null,
      height: exif?.ImageHeight ?? null,
      gps: lat != null && lon != null ? { lat, lon } : null,
    }
  } catch {
    // exifr 解析失败（如损坏文件）时返回空对象，由调用方兜底
    return { dateTaken: null, orientation: null, width: null, height: null, gps: null }
  }
}

/** 视频元数据（ffprobe 结果） */
export interface VideoMeta {
  duration: number | null
  width: number | null
  height: number | null
  /** 元数据里的创建时间（ISO8601）或 null */
  creationTime: string | null
}

/**
 * 全量 EXIF 元数据（信息面板用）。
 * 与扫描用的 readImageMeta 分离：扫描只需少量字段、追求速度；
 * 信息面板低频（点开才解析），一次全量取回不额外增加解析成本。
 */
export interface ImageFullMeta {
  takenAt: string | null
  /** 厂商，如 "Apple" */
  make: string | null
  /** 型号，如 "iPhone X" */
  model: string | null
  /** 镜头描述，如 "iPhone X back dual camera 4mm f/1.8" */
  lens: string | null
  iso: number | null
  /** 光圈值，如 2.4 */
  fNumber: number | null
  /** 焦距（毫米），如 52 */
  focalLength: number | null
  /** 快门（秒），如 1/25 → 0.04 */
  exposureTime: number | null
  /** 曝光补偿（EV），如 -1 */
  exposureBias: number | null
  gps: { lat: number; lon: number } | null
}

/**
 * EXIF rational（translateValues:false 时是 [分子, 分母] 或数字）→ 数字。
 * 例：FNumber 常见 [24, 10] → 2.4；FocalLength [52, 1] → 52。
 */
function rationalToNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (Array.isArray(v) && v.length === 2) {
    const [n, d] = v.map(Number)
    if (d === 0 || Number.isNaN(n) || Number.isNaN(d)) return null
    return n / d
  }
  return null
}

/** 解析图片全量 EXIF（信息面板用）。传入绝对路径。 */
export async function readImageFullMeta(absPath: string): Promise<ImageFullMeta> {
  try {
    const exif = await exifr.parse(absPath, { translateValues: false })
    const lat = dmsToDecimal(exif?.GPSLatitude)
    const lon = dmsToDecimal(exif?.GPSLongitude)
    return {
      takenAt: normalizeDate(exif?.DateTimeOriginal ?? exif?.CreateDate ?? null),
      make: exif?.Make ?? null,
      model: exif?.Model ?? null,
      lens: exif?.LensModel ?? null,
      iso: typeof exif?.ISO === 'number' ? exif.ISO : null,
      fNumber: rationalToNumber(exif?.FNumber),
      focalLength: rationalToNumber(exif?.FocalLength),
      exposureTime: rationalToNumber(exif?.ExposureTime),
      exposureBias: rationalToNumber(exif?.ExposureCompensation),
      gps: lat != null && lon != null ? { lat, lon } : null,
    }
  } catch {
    // 解析失败（损坏文件等）：返回全空，由调用方兜底展示
    return {
      takenAt: null, make: null, model: null, lens: null, iso: null,
      fNumber: null, focalLength: null, exposureTime: null, exposureBias: null, gps: null,
    }
  }
}

/** 全量视频元数据（信息面板用；在 VideoMeta 基础上增加编码/码率） */
export interface VideoFullMeta extends VideoMeta {
  /** 视频编码，如 "h264" / "hevc" */
  codec: string | null
  /** 码率（bps），优先视频流，回退容器 */
  bitRate: number | null
}

/** 解析视频全量元数据（信息面板用）。ffprobe 是回调封装，Promise 化。 */
export function readVideoFullMeta(absPath: string): Promise<VideoFullMeta> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(absPath, (err, data) => {
      if (err || !data?.format) {
        resolve({ duration: null, width: null, height: null, creationTime: null, codec: null, bitRate: null })
        return
      }
      const stream = data.streams?.find((s) => s.codec_type === 'video')
      const creation = (data.format.tags as Record<string, unknown> | undefined)?.creation_time
      resolve({
        duration: typeof data.format.duration === 'number' ? data.format.duration : null,
        width: stream?.width ?? null,
        height: stream?.height ?? null,
        creationTime: typeof creation === 'string' ? creation : null,
        codec: stream?.codec_name ?? null,
        bitRate: stream?.bit_rate != null ? Number(stream.bit_rate) : null,
      })
    })
  })
}

/** 解析视频元数据。ffprobe 是同步返回 Promise 的（fluent-ffmpeg 回调封装）。 */
export function readVideoMeta(absPath: string): Promise<VideoMeta> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(absPath, (err, data) => {
      if (err || !data?.format) {
        resolve({ duration: null, width: null, height: null, creationTime: null })
        return
      }
      const stream = data.streams?.find((s) => s.codec_type === 'video')
      const creation = (data.format.tags as Record<string, unknown> | undefined)?.creation_time
      resolve({
        duration: typeof data.format.duration === 'number' ? data.format.duration : null,
        width: stream?.width ?? null,
        height: stream?.height ?? null,
        creationTime: typeof creation === 'string' ? creation : null,
      })
    })
  })
}

/** 归一化 EXIF 时间字符串 → ISO8601（exifr 可能返回 Date 或字符串） */
export function normalizeDate(v: unknown): string | null {
  if (!v) return null
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString()
  const s = String(v).trim()
  if (!s) return null
  // 已带时区偏移（如 2025-02-17T18:55:12.000+08:00）直接返回
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s
  // "2025:02:17 18:55:12"（EXIF 常见格式）→ 补成 ISO8601
  const m = s.match(/(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`
  return null
}

/** 文件名（不含扩展名），用于实况配对 */
export function baseName(fileName: string): string {
  return path.basename(fileName, path.extname(fileName))
}
