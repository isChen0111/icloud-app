/**
 * 导入专用的「拍摄日期」确定链（去目录兜底）
 *
 * 与 scanner 的日期兜底链不同：导入来源是用户自己维护的、结构多样的目录，
 * 不能依赖「目录 YYYY/MM/DD」推断日期。scanner 保留目录兜底，但那是针对 icloudpd
 * 拉下来的固定 YYYY/MM/DD 结构（可靠）；导入场景不适用，故这里不走目录兜底这一环。
 * 这里的链是：
 *   图片：EXIF DateTimeOriginal → CreateDate（metadata.readImageMeta 内部已按此优先级）
 *   视频：ffprobe format.tags.creation_time
 *   都没有 → 文件 mtime 兜底（≈下载/复制时刻）
 *
 * 除日期外还返回「来源」（source）：落位后要判断是否需要补写 EXIF、以及该写什么值。
 *   - source='exif-datetime' → 已有 0x9003，不必补
 *   - source='exif-create'   → 有 0x9004 无 0x9003，用 CreateDate 的值填 0x9003
 *   - source='mtime'         → EXIF 全无，用 mtime 换算出的时间填
 */
import fs from 'node:fs'
import { readImageMeta, readVideoMeta, normalizeDate } from '../metadata/index.js'
import { toLocalIso } from '../utils/date.js'

export type MediaKind = 'image' | 'video'

/** 日期来源：决定补写 EXIF 时写什么、以及是否需要补 */
export type DateSource = 'exif-datetime' | 'exif-create' | 'video-creation' | 'mtime'

export interface ResolvedDate {
  /** 本地时间 + 偏移的 ISO8601（如 '2015-05-03T11:46:57+08:00'） */
  iso: string
  source: DateSource
}

/**
 * 解析单个媒体文件的拍摄日期及来源，文件不可读时返回 null（stat 失败）。
 * 复用 metadata 的 readImageMeta/readVideoMeta + normalizeDate，不重复实现 EXIF/ffprobe 解析。
 */
export async function resolveDate(absPath: string, kind: MediaKind): Promise<ResolvedDate | null> {
  if (kind === 'image') {
    const im = await readImageMeta(absPath)
    // 两个字段都已在 readImageMeta 里归一化成「本地时间 + 偏移」，不再二次转换
    if (im.dateTimeOriginal) return { iso: im.dateTimeOriginal, source: 'exif-datetime' }
    if (im.createDate) return { iso: im.createDate, source: 'exif-create' }
  } else {
    const vm = await readVideoMeta(absPath)
    const date = normalizeDate(vm.creationTime)
    if (date) return { iso: date, source: 'video-creation' }
  }
  // mtime 兜底（与 scanner 的 mtime 兜底同源；导入复制时会 preserveTimestamps 保留源 mtime，
  // 所以无 EXIF 的文件在「归置阶段」和「后续 runScan 落库阶段」拿到的日期一致）
  try {
    const st = fs.statSync(absPath)
    const iso = toLocalIso(st.mtime)
    return iso ? { iso, source: 'mtime' } : null
  } catch {
    return null
  }
}
