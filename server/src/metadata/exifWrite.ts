/**
 * EXIF 拍摄时间补写（只处理 JPEG）
 *
 * 背景：用户自己的照片目录里大量文件没有 EXIF 日期（全库普查 9440 张中 920 张无 0x9003，
 * 其中 820 张是 JPG），导入时只能靠文件 mtime 兜底定日期。mtime 会随复制/移动/云同步
 * 而变化，一旦变化，库里这张照片的日期就漂移。补写的意义是把「导入时已经确定下来的日期」
 * 固化进 EXIF，让文件自带答案，不再依赖文件系统时间。
 *
 * 为什么用 exiftool 而不是 sharp：
 *   sharp 写 EXIF 要走 decode → encode，原图会被重新压缩一次（有损，逐字节不一致）；
 *   exiftool 只重写 APP1 段，像素数据零改动。
 *
 * 为什么必须还原 mtime：
 *   写文件会让 mtime 变成「现在」，而 mtime 既是无 EXIF 文件的日期来源，也是导入判重的
 *   键（见 import/conflict.ts）。写完不还原 → 判重失配 → 重复导入时凭空多出 (1) 副本。
 *   exiftool 的 -P 会保留 mtime，但这里再加一层 stat 校验兜底，防止版本行为变化。
 *
 * 只写 0x9003 DateTimeOriginal + 0x9004 CreateDate 两个标签，不写 0x0132 ModifyDate：
 *   库里存在 0x0132 与真实拍摄时间相差半个月的实例（2024/10/18/89dc0348….JPG），
 *   该标签不可靠，项目也不读它，写了只会误导别的软件。
 */
import fs from 'node:fs'
import path from 'node:path'
import { ExifTool } from 'exiftool-vendored'

/** 可补写的扩展名（只做 JPEG；HEIC/PNG 的 EXIF 与视频 creation_time 不在本轮范围） */
const PATCHABLE_EXTS = new Set(['.jpg', '.jpeg'])

/** 单次写入超时：大 JPEG（几 MB）留足余量 */
const TOOL_OPTIONS = { taskTimeoutMillis: 60_000, maxProcs: 1 }

let tool: ExifTool | null = null

/** 懒加载常驻 exiftool 进程（首调用约 200~400ms，之后每文件一次 RPC） */
function getTool(): ExifTool {
  if (!tool) tool = new ExifTool(TOOL_OPTIONS)
  return tool
}

/** 关闭常驻进程：测试 after 与服务退出时调用，否则进程不退出 */
export async function closeExifTool(): Promise<void> {
  if (!tool) return
  const t = tool
  tool = null
  await t.end()
}

/** exiftool 是否可用（二进制缺失/被杀软拦截时为 false，调用方据此整体降级跳过补写） */
export async function isExifToolAvailable(): Promise<boolean> {
  try {
    await getTool().version()
    return true
  } catch (err) {
    console.warn('[exif] exiftool 不可用，本轮跳过补写:', (err as Error).message)
    return false
  }
}

/** 是否属于可补写的文件（仅按扩展名，不看内容） */
export function isPatchableImage(absPath: string): boolean {
  return PATCHABLE_EXTS.has(path.extname(absPath).toLowerCase())
}

/**
 * 本地 ISO8601（'2026-11-01T11:34:18+08:00'）→ EXIF 时间格式（'2026:11:01 11:34:18'）。
 *
 * 注意取的是字符串里的「本地时间」部分，不带时区换算：EXIF 没有时区概念，
 * 各软件都按本地时间理解，写偏移后的 UTC 时间会整体偏 8 小时。
 */
export function toExifDateTime(localIso: string): string {
  const m = localIso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/)
  if (!m) throw new Error(`无法转换为 EXIF 时间格式: ${localIso}`)
  return `${m[1]}:${m[2]}:${m[3]} ${m[4]}:${m[5]}:${m[6]}`
}

/**
 * 把拍摄时间写入文件的 DateTimeOriginal + CreateDate，并保证 mtime 不变。
 *
 * @param absPath  目标绝对路径（调用方保证是 JPEG）
 * @param localIso 要写入的日期（本地时间 + 偏移的 ISO8601，如导入时 resolveDate 的结果）
 * @throws exiftool 执行失败（文件被占用、只读、非 JPEG 等）时向上抛，由调用方记失败计数
 */
export async function writeDateTaken(absPath: string, localIso: string): Promise<void> {
  const exifDt = toExifDateTime(localIso)
  const before = fs.statSync(absPath)
  await getTool().write(
    absPath,
    { DateTimeOriginal: exifDt, CreateDate: exifDt },
    ['-overwrite_original', '-P'],
  )
  // 兜底：-P 未生效时手动还原 mtime（判重键不能被写 EXIF 带跑）
  const after = fs.statSync(absPath)
  if (Math.trunc(after.mtimeMs) !== Math.trunc(before.mtimeMs)) {
    fs.utimesSync(absPath, before.atime, before.mtime)
  }
}
