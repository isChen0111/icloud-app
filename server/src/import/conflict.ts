/**
 * 目标目录计算 + 同名冲突处理
 *
 * 导入把文件按拍摄日期归置到 `import/YYYY/MM/DD/` 下。同名冲突策略：
 *   目标路径不存在 → 直接用原名；
 *   目标已存在且 mtime 相同 → 视为「已导入」，跳过（不重复占空间）；
 *   目标已存在但 mtime 不同 → 文件名加后缀 (1)、(2)…（绝不覆盖，因为导入不破坏已有文件）。
 *
 * 为什么判重只比 mtime、不比 size（2026-11-01 决定，方案 1）：
 *   导入落位后会对缺日期的 JPEG 补写 EXIF（见 metadata/exifWrite.ts），补写会改变文件
 *   字节数（实测 274 → 3445），而 mtime 被 exiftool -P 与写后 stat 校验双重保住原值。
 *   若仍按「同名 + size + mtime」三键判重，第二次导入同一批文件时 size 已变 → 被判成
 *   「同名但内容不同的另一个文件」→ 每重导一次就多一份 (n) 副本，且 skipped 计数永远不涨。
 *   mtime 本来就是这个项目里「拍摄时间的载体」（无 EXIF 文件的日期来源），拿它当同名文件
 *   的唯一区分键，语义上正好对应「这就是同一个文件」。
 *   代价：同目录下「同名 + mtime 精确到毫秒相同 + 内容不同」的两个文件会被误判为已导入而
 *   跳过一份。要同时满足这三个条件基本只有一种可能——同一个文件被原地改过内容却保留了
 *   mtime；而本项目自己补 EXIF 时是「先落位、后补写」，不会产生这种状态。
 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * mtime 比较容差（毫秒）。
 *
 * 现场实测（2026-11-01，lib6/import/2020/01/02/有日期照片.jpg）：
 *   源文件 mtimeMs = 1793504594331.9983（带亚毫秒尾数）
 *   复制后目标  = 1793504594332      （Windows 保留时间戳时按 100ns 单位进位）
 * 两者截断后差 1ms，严格相等判定会把同一个文件当成两个，重复导入时凭空多出 (n) 副本。
 * 只要源 mtime 带亚毫秒尾数（真实照片几乎都带）就可能触发，因此必须有 1ms 容差。
 * 容差不能再放宽：同一目录下同名文件本来就不可能共存，1ms 内的差异只能是同一次复制的表示误差。
 */
const MTIME_TOLERANCE_MS = 1

/** ISO8601 拍摄日期 → 'YYYY/MM/DD' 目录段（取前 10 字符，'-' 换 '/'） */
export function dateToDir(iso: string): string {
  const y = iso.slice(0, 4)
  const m = iso.slice(5, 7)
  const d = iso.slice(8, 10)
  return `${y}/${m}/${d}`
}

export interface PickResult {
  /** 最终目标绝对路径 */
  targetPath: string
  /** true = 目标已存在同 mtime 文件，应跳过（不复制） */
  skipped: boolean
}

/**
 * 在目标目录下为源文件挑一个不冲突的目标路径。
 *
 * @param importRoot 导入子目录根（= libraryImportDir(lib.library_root)）
 * @param dateDir    日期目录段（'YYYY/MM/DD'）
 * @param fileName   源文件名（含扩展名）
 * @param srcMtimeMs 源文件 mtime（毫秒，取整对齐）
 */
export function pickTargetName(
  importRoot: string,
  dateDir: string,
  fileName: string,
  srcMtimeMs: number,
): PickResult {
  const ext = path.extname(fileName)
  const stem = path.basename(fileName, ext)
  const srcMtime = Math.trunc(srcMtimeMs)
  // 后缀上限 10000 防死循环（同一目录下同名冲突异常多，几乎不可能）
  for (let i = 0; i < 10000; i++) {
    const name = i === 0 ? fileName : `${stem}(${i})${ext}`
    const p = path.join(importRoot, dateDir, name)
    if (!fs.existsSync(p)) return { targetPath: p, skipped: false }
    const st = fs.statSync(p)
    if (Math.abs(st.mtimeMs - srcMtime) <= MTIME_TOLERANCE_MS) {
      return { targetPath: p, skipped: true }
    }
  }
  throw new Error(`同名冲突过多，无法为 ${fileName} 分配新文件名`)
}
