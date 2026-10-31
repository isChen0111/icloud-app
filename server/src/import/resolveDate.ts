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
 */
import fs from 'node:fs'
import { readImageMeta, readVideoMeta, normalizeDate } from '../metadata/index.js'
import { toLocalIso } from '../utils/date.js'

export type MediaKind = 'image' | 'video'

/**
 * 解析单个媒体文件的拍摄日期，返回「本地时间 + 偏移」ISO8601 或 null（stat 失败）。
 * 复用 metadata 的 readImageMeta/readVideoMeta + normalizeDate，不重复实现 EXIF/ffprobe 解析。
 */
export async function resolveDate(absPath: string, kind: MediaKind): Promise<string | null> {
  let date: string | null = null
  if (kind === 'image') {
    const im = await readImageMeta(absPath)
    date = normalizeDate(im.dateTaken)
  } else {
    const vm = await readVideoMeta(absPath)
    date = normalizeDate(vm.creationTime)
  }
  if (date) return date
  // mtime 兜底（与 scanner 的 mtime 兜底同源；导入复制时会 preserveTimestamps 保留源 mtime，
  // 所以无 EXIF 的文件在「归置阶段」和「后续 runScan 落库阶段」拿到的日期一致）
  try {
    const st = fs.statSync(absPath)
    return toLocalIso(st.mtime) ?? null
  } catch {
    return null
  }
}
