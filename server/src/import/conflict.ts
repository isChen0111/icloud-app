/**
 * 目标目录计算 + 同名冲突处理
 *
 * 导入把文件按拍摄日期归置到 `import/YYYY/MM/DD/` 下。同名冲突策略：
 *   目标路径不存在 → 直接用原名；
 *   目标已存在且 size+mtime 相同 → 视为「已导入」，跳过（不重复占空间）；
 *   目标已存在但内容不同 → 文件名加后缀 (1)、(2)…（绝不覆盖，因为导入不破坏已有文件）。
 */
import fs from 'node:fs'
import path from 'node:path'

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
  /** true = 目标已存在同 size+mtime 文件，应跳过（不复制） */
  skipped: boolean
}

/**
 * 在目标目录下为源文件挑一个不冲突的目标路径。
 *
 * @param importRoot 导入子目录根（= libraryImportDir(lib.library_root)）
 * @param dateDir    日期目录段（'YYYY/MM/DD'）
 * @param fileName   源文件名（含扩展名）
 * @param srcSize    源文件字节数
 * @param srcMtimeMs 源文件 mtime（毫秒，取整对齐）
 */
export function pickTargetName(
  importRoot: string,
  dateDir: string,
  fileName: string,
  srcSize: number,
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
    if (st.size === srcSize && Math.trunc(st.mtimeMs) === srcMtime) {
      return { targetPath: p, skipped: true }
    }
  }
  throw new Error(`同名冲突过多，无法为 ${fileName} 分配新文件名`)
}
