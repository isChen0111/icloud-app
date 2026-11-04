/**
 * 元数据提取
 *
 * 从媒体文件中读取「拍摄时间 / 尺寸 / 方向 / GPS / 时长」。
 * - 图片：exifr 解析 EXIF（支持 HEIC/JPEG/PNG）。部分文件 EXIF 缺失时，
 *   用 sharp 读像素尺寸兜底。
 * - 视频：ffprobe（vendor 里的 BtbN full 版）读取时长与分辨率，并从元数据中找
 *   creation_time；找不到就用目录日期/文件时间兜底。
 */
import exifr from 'exifr'
import path from 'node:path'
import { ffprobeJson } from '../ffmpeg.js'
import { toLocalIso } from '../utils/date.js'

/** 从目录 YYYY/MM/DD 解析日期（iCloudPD 默认结构），失败返回 null */
export function parseDateFromDir(filePath: string): string | null {
  // 例：2025/02/17/IMG_1234.HEIC → ['2025','02','17']
  const normalizedPath = filePath.replace(/\\/g, '/')
  const m = normalizedPath.match(/(\d{4})\/(\d{2})\/(\d{2})\//)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (y < 1970 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null
  // 目录只能精确到天 → 取「本地当天零点」。用本地 Date 构造而不是硬编码 +08:00，
  // 这样换时区也不会写错偏移（审查 R-08：与 EXIF 路径统一为同一个表示）
  return toLocalIso(new Date(y, mo - 1, d))
}

/**
 * 库内「目录日期可信」的子树白名单。
 *
 * 只有这两处的 YYYY/MM/DD 是程序自己按真实拍摄日期建出来的：
 *   - `icloud/`：icloudpd 按 iCloud 返回的 assetDate 建目录，结构固定；
 *   - `import/`：导入时按 resolveDate() 的结果建目录。
 *
 * 库根下的其他位置都可能是用户手动复制进来的，目录名与拍摄日期没有必然关系。
 * 实测反例（2026-11-01）：把一个备份目录整体复制成 `lib/我的备份/2021/07/08/`，
 * 里面那张 2016 年拍的照片会被目录日期强行改成 2021-07-08 零点——既错日期，
 * 又丢秒级精度。因此白名单外的路径一律不采信目录，只走 EXIF → mtime。
 */
const TRUSTED_DATE_SUBTREES = ['icloud/', 'import/']

/** 该库内相对路径是否位于「目录日期可信」的子树内（见 TRUSTED_DATE_SUBTREES） */
export function isTrustedDateDir(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/')
  return TRUSTED_DATE_SUBTREES.some((prefix) => normalized.startsWith(prefix))
}

/** 图片元数据（EXIF 提取结果） */
export interface ImageMeta {
  /** 拍摄时间（ISO8601 字符串）或 null；= dateTimeOriginal ?? createDate */
  dateTaken: string | null
  /**
   * EXIF 0x9003 DateTimeOriginal（已归一化）。null 表示文件**没有该标签**——
   * 补写 EXIF 的判据就是它是否为 null（见 metadata/exifWrite.ts），
   * 所以这里不能和 CreateDate 合并成 dateTaken，否则分不清「本来就有」和「兜底来的」。
   */
  dateTimeOriginal: string | null
  /** EXIF 0x9004 CreateDate / DateTimeDigitized（已归一化），null 表示没有该标签 */
  createDate: string | null
  /** EXIF 方向 1~8 */
  orientation: number | null
  /** 像素尺寸（可能为 null，此时需 sharp 兜底） */
  width: number | null
  height: number | null
  gps: { lat: number; lon: number } | null
  /**
   * 实况内容标识（Apple MakerNote 0x0011，36 字符 UUID）。
   * 与配对视频的 `com.apple.quicktime.content.identifier` 相同即同一张实况。
   * null = 文件里没有这个标签（非 Apple 来源 / 非实况 / 被外部工具剥掉了 MakerNote）。
   */
  contentIdentifier: string | null
}

/** Apple MakerNote 里实况内容标识的 tag 号（ExifTool 命名为 ContentIdentifier） */
const APPLE_MAKERNOTE_CID_TAG = 0x0011

/** UUID 文本形态（36 字符，带连字符） */
const UUID_TEXT_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/**
 * exifr 的 makerNote 原始字节 → Buffer。
 *
 * exifr 7.x 没有 Apple MakerNote 的标签表，`{ makerNote: true }` 时把整块未解析的
 * 字节返回成「偏移 → 字节值」的普通对象（如 `{0: 65, 1: 112, …}`）。JavaScript 规范
 * 保证整数索引键按升序枚举，所以 Object.values 的顺序就是原始字节顺序（2026-11-04 实测）。
 * 另外几种形态一并兼容，避免 exifr 升级换表示后静默取不到值。
 */
function makerNoteToBuffer(raw: unknown): Buffer | null {
  if (!raw) return null
  if (Buffer.isBuffer(raw)) return raw
  if (raw instanceof Uint8Array) return Buffer.from(raw)
  if (Array.isArray(raw)) {
    return raw.every((v) => typeof v === 'number') ? Buffer.from(raw as number[]) : null
  }
  if (typeof raw === 'object') {
    const values = Object.values(raw as Record<string, unknown>)
    if (values.length > 0 && values.every((v) => typeof v === 'number')) {
      return Buffer.from(values as number[])
    }
  }
  return null
}

/** 在字节里兜底匹配 UUID 文本（结构解析失败时用） */
function matchUuidText(buf: Buffer): string | null {
  const m = buf.toString('latin1').match(UUID_TEXT_RE)
  return m ? m[0] : null
}

/**
 * 从图片的 MakerNote 原始字节里取实况内容标识（UUID）。
 *
 * Apple MakerNote 布局（0 基偏移，2026-11-04 用真实 iPhone HEIC 核对）：
 *   0..8   "Apple iOS\0"
 *   12..14 字节序（"II" 小端 / "MM" 大端）
 *   16..20 首个 IFD 的偏移，**相对字节序字段**（即整体减 12 才是 0 基绝对偏移）
 *   其后是标准 TIFF IFD：2 字节条目数，每条 12 字节（tag/type/len/value），最后 4 字节 next IFD 指针
 *
 * 0x0011 的 type 是 7（UNDEFINED），长度 36，值是指向字符串的偏移；长度 ≤4 时值内联在条目里。
 *
 * 分两层：先按结构精确命中；结构不认识（非 Apple 设备 / 未预期的变体）就退化为
 * 全文正则。正则不会错配到「假 UUID」之外的字段——这个值本身恒为 36 字符 UUID 形态，
 * 而 MakerNote 里出现第二段同格式字符串的概率可忽略。
 */
export function extractContentIdentifier(makerNote: unknown): string | null {
  const buf = makerNoteToBuffer(makerNote)
  if (!buf || buf.length < 24) return null

  // 非 Apple MakerNote（安卓等）：不做结构解析，直接正则兜底
  if (!buf.subarray(0, 9).toString('latin1').startsWith('Apple ')) return matchUuidText(buf)

  const order = buf.subarray(12, 14).toString('latin1')
  const le = order === 'II'
  if (!le && order !== 'MM') return matchUuidText(buf)
  const readU16 = (o: number): number => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o))
  const readU32 = (o: number): number => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o))
  /** 结构内所有偏移相对字节序字段，换算成 0 基绝对偏移 */
  const toAbs = (rel: number): number => 12 + rel

  let ifdRel = readU32(16)
  // 跟随 IFD 链（不同 iOS 版本 0x0011 可能不在第一个 IFD 里），最多 4 层防坏数据死循环
  for (let hop = 0; hop < 4 && ifdRel > 0; hop++) {
    const ifd = toAbs(ifdRel)
    if (ifd + 2 > buf.length) break
    const count = readU16(ifd)
    if (count === 0 || count > 512) break
    for (let i = 0; i < count; i++) {
      const entry = ifd + 2 + i * 12
      if (entry + 12 > buf.length) break
      if (readU16(entry) !== APPLE_MAKERNOTE_CID_TAG) continue
      const len = readU32(entry + 4)
      if (len === 0 || len > 128) continue
      const valueStart = len > 4 ? toAbs(readU32(entry + 8)) : entry + 8
      if (valueStart + len > buf.length) continue
      const text = buf
        .subarray(valueStart, valueStart + len)
        .toString('latin1')
        .replace(/\0+$/, '')
        .trim()
      if (UUID_TEXT_RE.test(text)) return text
    }
    const nextPtr = ifd + 2 + count * 12
    if (nextPtr + 4 > buf.length) break
    ifdRel = readU32(nextPtr)
  }
  // 结构走完没命中：可能是未预期的变体，最后用正则兜底
  return matchUuidText(buf)
}

/** 度分秒数组（EXIF 的 GPS 格式）→ 十进制度数。例：DMS [50,30,10] → 50.5028 */
function dmsToDecimal(v: unknown): number | null {
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
      /**
       * 实况 UUID 藏在 Apple MakerNote 里，必须显式打开（exifr 默认不读 MakerNote）。
       * 代价实测为零：MakerNote 就在 EXIF 段内，开与不开的解析耗时都在噪声范围内，
       * 所以顺手取走，不额外起一次 IO（这也是不用 exiftool 读图片侧的原因——27ms/个）。
       */
      makerNote: true,
    })
    const lat = dmsToDecimal(exif?.GPSLatitude)
    const lon = dmsToDecimal(exif?.GPSLongitude)
    // 分别归一化再合并：dateTaken 供扫描/展示用，另外两个供补写判据用
    const dateTimeOriginal = normalizeDate(exif?.DateTimeOriginal)
    const createDate = normalizeDate(exif?.CreateDate)
    return {
      dateTaken: dateTimeOriginal ?? createDate,
      dateTimeOriginal,
      createDate,
      orientation: exif?.Orientation ?? null,
      width: exif?.ImageWidth ?? null,
      height: exif?.ImageHeight ?? null,
      gps: lat != null && lon != null ? { lat, lon } : null,
      contentIdentifier: extractContentIdentifier((exif as { makerNote?: unknown } | undefined)?.makerNote),
    }
  } catch {
    // exifr 解析失败（如损坏文件）时返回空对象，由调用方兜底
    return {
      dateTaken: null,
      dateTimeOriginal: null,
      createDate: null,
      orientation: null,
      width: null,
      height: null,
      gps: null,
      contentIdentifier: null,
    }
  }
}

/** 视频元数据（ffprobe 结果） */
export interface VideoMeta {
  duration: number | null
  width: number | null
  height: number | null
  /** 元数据里的创建时间（ISO8601）或 null */
  creationTime: string | null
  /**
   * 实况内容标识（`com.apple.quicktime.content.identifier`）。
   * 与静止帧的 MakerNote UUID 相同即同一张实况；独立视频/非 Apple 来源为 null。
   * 走 format.tags 白拿——这个 tag 本来就在 ffprobe 的输出里，不额外加 IO。
   */
  contentIdentifier: string | null
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

function numOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** 解析视频全量元数据（信息面板用）。 */
export async function readVideoFullMeta(absPath: string): Promise<VideoFullMeta> {
  try {
    const data = await ffprobeJson(absPath)
    if (!data.format) {
      return {
        duration: null, width: null, height: null, creationTime: null,
        contentIdentifier: null, codec: null, bitRate: null,
      }
    }
    const stream = data.streams?.find((s) => s.codec_type === 'video')
    const creation = data.format.tags?.creation_time
    // 实况 MOV 的 UUID：ffprobe 把它放在容器级 tags 里（-show_format 已含全部 tags）
    const cid = data.format.tags?.['com.apple.quicktime.content.identifier']
    return {
      duration: numOrNull(data.format.duration),
      width: stream?.width ?? null,
      height: stream?.height ?? null,
      creationTime: typeof creation === 'string' ? creation : null,
      contentIdentifier: typeof cid === 'string' && cid.trim() ? cid.trim() : null,
      codec: stream?.codec_name ?? null,
      bitRate: numOrNull(stream?.bit_rate) ?? numOrNull(data.format.bit_rate),
    }
  } catch {
    return {
      duration: null, width: null, height: null, creationTime: null,
      contentIdentifier: null, codec: null, bitRate: null,
    }
  }
}

/** 解析视频元数据。 */
export async function readVideoMeta(absPath: string): Promise<VideoMeta> {
  const full = await readVideoFullMeta(absPath)
  return {
    duration: full.duration,
    width: full.width,
    height: full.height,
    creationTime: full.creationTime,
    contentIdentifier: full.contentIdentifier,
  }
}

/**
 * 归一化 EXIF 时间字符串 → 「本地时间 + 偏移」ISO8601（exifr 可能返回 Date 或字符串）。
 *
 * R-08（2026-10-28）：原来 Date 分支返回 `toISOString()`（UTC，带 Z），
 * 与目录兜底的 `+08:00` 表示混在同一列，导致排序错位、按月分组切到 UTC 月份。
 * 现在所有分支都收敛到 `toLocalIso()` 的同一个表示。
 */
export function normalizeDate(v: unknown): string | null {
  if (!v) return null
  if (v instanceof Date) return toLocalIso(v)
  const s = String(v).trim()
  if (!s) return null
  // 已含日期时间（如 exifr 的 "2025-02-17T18:55:12.000+08:00"、ffprobe 的
  // "2024-09-13T00:40:28.000000Z"）→ 解析后统一成本地偏移表示，不再原样返回。
  // 注意 ffprobe 会给 6 位小数：先截到 3 位再交给 Date，避免个别运行时解析成 Invalid Date。
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    const d = new Date(s.replace(/(\.\d{3})\d+/, '$1'))
    return Number.isNaN(d.getTime()) ? null : toLocalIso(d)
  }
  // "2025:02:17 18:55:12"（EXIF 常见格式，无时区）→ 按本地时间解释后统一表示
  const m = s.match(/(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (m) {
    const local = new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6]),
    )
    return toLocalIso(local)
  }
  return null
}

/** 文件名（不含扩展名），用于实况配对 */
export function baseName(fileName: string): string {
  return path.basename(fileName, path.extname(fileName))
}
