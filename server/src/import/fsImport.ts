/**
 * 导入核心流水线（本机迁移与上传共用）
 *
 * 职责边界：只负责「把文件按拍摄日期归置到 import/YYYY/MM/DD/」，不写 DB、不做配对入库。
 * 落库统一交给 scanner 的 runScan()（导入结束后由编排层调用），复用缩略图预热与删除对账。
 *
 * 关键正确性（见计划 §四）：
 *   复制时用 fs.cp({ preserveTimestamps: true }) 保留源文件 mtime——无 EXIF 的文件归置到
 *   import/YYYY/MM/DD 后，后续 runScan 无论命中「目录兜底」还是「mtime 兜底」，得到的日期
 *   都与归置阶段 resolveDate 的结果同一天，避免退化成「复制时刻」导致日期错乱。
 */
import fs from 'node:fs'
import path from 'node:path'
import { walkDir } from '../scanner/index.js'
import { resolveDate } from './resolveDate.js'
import { dateToDir, pickTargetName } from './conflict.js'
import { groupByPair, type RawImportFile } from './pair.js'
import { importState } from './state.js'
import type { ImportOptions, ImportStatus } from './types.js'

/** 与 scanner 一致的媒体扩展名（小写） */
const IMAGE_EXTS = new Set(['.heic', '.heif', '.jpg', '.jpeg', '.png', '.gif', '.tiff'])
const VIDEO_EXTS = new Set(['.mov', '.mp4', '.m4v', '.avi'])

/** 失败清单环形缓冲上限 */
const MAX_FAILURES = 200

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * 是否已被取消。cancelImport() 在另一个函数里把 importState.status 改成 'cancelled'，
 * TS 的流分析在本函数内会把 status 窄化为 'running'，故显式按宽类型比较。
 */
function isCancelled(): boolean {
  return (importState.status as ImportStatus) === 'cancelled'
}

function recordFailure(relPath: string, reason: string): void {
  importState.failedCount++
  importState.failures.push({ relPath, reason })
  if (importState.failures.length > MAX_FAILURES) importState.failures.shift()
}

/**
 * 跨盘安全移动：同盘走 rename（快）；跨盘 rename 抛 EXDEV → copyFile + unlink。
 * 移动失败（copyFile 成功但 unlink 失败）会向上抛错，由调用方记失败清单，
 * 源文件不被静默删除，保证「不丢文件」。
 */
async function moveFileCrossSafe(src: string, dst: string): Promise<void> {
  try {
    await fs.promises.rename(src, dst)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      await fs.promises.copyFile(src, dst)
      await fs.promises.unlink(src)
    } else {
      throw err
    }
  }
}

/**
 * 递归收集源目录下的媒体文件，返回带签名（size + mtimeMs）的文件列表。
 * 复用 scanner 的 walkDir（处理隐藏目录/符号链接/目录读取失败），这里只做扩展名过滤与 stat。
 */
export async function collectSourceFiles(sourceDir: string): Promise<RawImportFile[]> {
  const { files, errors } = await walkDir(sourceDir)
  const result: RawImportFile[] = []
  let statIndex = 0
  for (const abs of files) {
    // stat 是同步调用，每 200 个让出一次事件循环（对齐 scanner R-19 的做法）
    if (++statIndex % 200 === 0) await yieldToEventLoop()
    const lowerName = path.basename(abs).toLowerCase()
    const ext = path.extname(abs).toLowerCase() || (IMAGE_EXTS.has(lowerName) || VIDEO_EXTS.has(lowerName) ? lowerName : '')
    if (!IMAGE_EXTS.has(ext) && !VIDEO_EXTS.has(ext)) continue
    let size = 0
    let mtimeMs = 0
    try {
      const st = fs.statSync(abs)
      size = st.size
      mtimeMs = Math.trunc(st.mtimeMs)
    } catch {
      continue // 文件瞬时不可读（刚被移动/删除）→ 跳过
    }
    result.push({
      absPath: abs,
      relPath: path.relative(sourceDir, abs),
      fileName: path.basename(abs),
      kind: IMAGE_EXTS.has(ext) ? 'image' : 'video',
      size,
      mtimeMs,
    })
  }
  if (errors.length > 0) {
    // 目录读取失败不中断整体，只记日志；相关文件本轮不导入（下次重试可见）
    console.warn(`[import] 源目录有 ${errors.length} 处读取失败，相关文件不会导入`)
  }
  return result
}

/**
 * 导入主循环：遍历 → 配对 → 提日期 → 归置（复制/移动）。
 *
 * 单文件失败不中断整体：失败记入 failures，继续下一个。取消（status='cancelled'）
 * 由 cancelImport() 设置，主循环每处理一个资产检查一次即退。
 */
export async function importDirectory(opts: ImportOptions): Promise<void> {
  const raw = await collectSourceFiles(opts.sourceDir)
  const assets = groupByPair(raw)

  let total = 0
  for (const a of assets) total += 1 + (a.liveVideo ? 1 : 0)
  // 注：status='running' 由编排层（import/index.ts）在启动时设置，这里只更新进度计数，
  // 避免覆盖 cancelImport 提前设置的 'cancelled'。结尾再据取消与否设置终态。
  importState.totalFiles = total
  importState.processedFiles = 0
  importState.skipped = 0
  importState.failedCount = 0
  importState.failures = []
  importState.startedAt = new Date().toISOString()
  importState.message = '正在导入…'

  let processed = 0
  for (const asset of assets) {
    if (isCancelled()) break
    const parts = [asset.image, asset.liveVideo].filter((f): f is RawImportFile => f !== null)
    // 以主资产（图片/独立视频）的日期为准，实况视频跟随进同一日期目录（保证同目录不拆散）
    const date = await resolveDate(asset.image.absPath, asset.image.kind)
    if (!date) {
      for (const f of parts) recordFailure(f.relPath, '无法确定拍摄日期（元数据与文件信息均不可读）')
      processed += parts.length
      importState.processedFiles = processed
      continue
    }
    const ymd = dateToDir(date)
    fs.mkdirSync(path.join(opts.targetRoot, ymd), { recursive: true })

    for (const f of parts) {
      if (isCancelled()) break
      try {
        const { targetPath, skipped } = pickTargetName(opts.targetRoot, ymd, f.fileName, f.size, f.mtimeMs)
        if (skipped) {
          importState.skipped++
        } else if (opts.mode === 'copy') {
          // preserveTimestamps 是关键：保留源 mtime，让无 EXIF 文件后续 runScan 的 mtime 兜底日期正确
          await fs.promises.cp(f.absPath, targetPath, { preserveTimestamps: true })
        } else {
          await moveFileCrossSafe(f.absPath, targetPath)
        }
      } catch (err) {
        recordFailure(f.relPath, (err as Error).message)
      }
      processed++
      importState.processedFiles = processed
    }
    // 每处理若干资产让出一次事件循环，避免大目录导入期间阻塞 HTTP 轮询
    if (processed % 10 === 0) await yieldToEventLoop()
  }

  if (isCancelled()) {
    importState.message = '已取消'
  } else {
    importState.status = 'done'
    importState.message = '导入完成'
  }
  importState.finishedAt = new Date().toISOString()
}
