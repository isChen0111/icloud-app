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
import { resolveDate, type ResolvedDate } from './resolveDate.js'
import { dateToDir, pickTargetName } from './conflict.js'
import { groupByPair, type RawImportFile } from './pair.js'
import { importState, currentImportToken, isImportCancelRequested } from './state.js'
import { isExifToolAvailable, isPatchableImage, writeDateTaken, MtimeRestoreError } from '../metadata/exifWrite.js'
import type { ImportOptions } from './types.js'

/** 与 scanner 一致的媒体扩展名（小写） */
const IMAGE_EXTS = new Set(['.heic', '.heif', '.jpg', '.jpeg', '.png', '.gif', '.tiff'])
const VIDEO_EXTS = new Set(['.mov', '.mp4', '.m4v', '.avi'])

/** 失败清单环形缓冲上限 */
const MAX_FAILURES = 200

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * 跨盘安全移动：同盘走 rename（原子、快）；跨盘 rename 抛 EXDEV 时
 * 「拷到 .part → rename 到正式名 → 最后删源」。
 *
 * 审查 C-07：旧实现在 EXDEV 分支用 `copyFile`，它**不保留 mtime**（与 `fs.cp` 不同）。
 * 无 EXIF 的 HEIC/PNG/视频归置后日期只能靠 mtime 兜底，mtime 丢了就变成「今天」，
 * 判重键（size+mtime）跟着失效，重复导入会多出 (n) 副本。
 *
 * 审查 C-09：直接写正式文件名不原子——拷一半失败/取消/断电会在正式路径上留截断文件，
 * 紧接着的 runScan 会把它当正常资产入库（照片墙上出现永远打不开的图）。
 * 所以先写同目录 `.part`，再 rename（同分区原子）。
 *
 * 顺序上「先删源还是先落位」也有讲究：rename 成功之后才 unlink 源文件，
 * 任何一步失败都不会出现「源已删、副本没落位」的丢文件情形。
 */
async function moveFileCrossSafe(src: string, dst: string): Promise<void> {
  try {
    await fs.promises.rename(src, dst)
    return
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
  }
  const tmp = partPath(dst)
  try {
    // preserveTimestamps：与 copy 模式保持一致（C-07）
    await fs.promises.cp(src, tmp, { preserveTimestamps: true })
    await fs.promises.rename(tmp, dst)
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
  await fs.promises.unlink(src)
}

/** 同目录临时名：`.part` 后缀不会被 scanner 当媒体文件（扩展名不在白名单里） */
function partPath(targetPath: string): string {
  return `${targetPath}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.part`
}

/**
 * 原子复制：先写同目录 .part 再 rename（审查 C-09）。
 * 失败时清掉 .part，正式路径上不会出现半写文件。
 *
 * 导出供单测直接验证「mtime 保留 + 失败不留半成品」两条契约；
 * cross-device move 分支用的是同一套（`fs.cp` + rename），只是多了 unlink 源。
 */
export async function copyAtomically(src: string, dst: string): Promise<void> {
  const tmp = partPath(dst)
  try {
    // preserveTimestamps 是关键：保留源 mtime，让无 EXIF 文件后续 runScan 的 mtime 兜底日期正确
    await fs.promises.cp(src, tmp, { preserveTimestamps: true })
    await fs.promises.rename(tmp, dst)
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {})
    throw err
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
 * 归置阶段的结果（审查 C-06）：只报告「拷完了没有、该显示什么」，**不写终态**。
 * 终态要等编排层跑完 runScan 落库再写，否则前端会在库里还没有数据时就显示「导入完成」。
 */
export interface ImportRunResult {
  /** 归置阶段是否因收到取消而提前结束 */
  cancelled: boolean
  /** 终态文案（编排层写 status 时一并写入） */
  message: string
}

/**
 * 清理上次导入中断留下的 `.part`（配合 C-09 的原子写）。
 *
 * 原子写保证正式文件名上不会出现半写文件，代价是崩溃/强杀会留下 `.part` 残体。
 * 它们扩展名不在媒体白名单里，scanner 会忽略，但会一直占着磁盘。
 * 导入开始前扫一遍：同一时刻只允许一个导入任务，所以此刻不可能是「正在写的」。
 */
export async function cleanupPartFiles(root: string): Promise<void> {
  if (!fs.existsSync(root)) return
  let removed = 0
  const { files } = await walkDir(root)
  for (const abs of files) {
    if (!abs.endsWith('.part')) continue
    try {
      await fs.promises.rm(abs, { force: true })
      removed++
    } catch {
      /* 单个残体删不掉不影响导入 */
    }
  }
  if (removed > 0) console.log(`[import] 已清理 ${removed} 个上次中断残留的 .part 文件`)
}

/**
 * 导入主循环：遍历 → 配对 → 提日期 → 归置（复制/移动）→ 补写 EXIF。
 *
 * 单文件失败不中断整体：失败记入 failures，继续下一个。
 *
 * 取消与令牌（审查 C-01）：取消由 `requestImportCancel()` 置信号，主循环每处理一个
 * 资产检查一次即退。所有状态写回都先校验 `token` 仍是当前令牌——一旦有新任务接管
 * （理论上被 isImportBusy 挡住，这里是兜底），本流水线立刻停手且不再写任何状态，
 * 避免旧流水线把新任务的进度与终态冲掉。
 *
 * 终态归属（审查 C-06）：本函数**只负责归置**，结束时不再写 `status`/`finishedAt`，
 * 而是把结果返回给编排层——落库扫描还没跑，此刻「完成」是假完成。
 *
 * @param token 本次运行的令牌；默认取当前令牌（测试直接调用时的常见情形）
 */
export async function importDirectory(
  opts: ImportOptions,
  token: number = currentImportToken(),
): Promise<ImportRunResult> {
  /** 本流水线是否仍持有令牌（被新任务接管后为 false） */
  const owns = (): boolean => token === currentImportToken()
  /** 应当停止处理：被接管 或 收到取消请求 */
  const stopped = (): boolean => !owns() || isImportCancelRequested()

  const recordFailure = (relPath: string, reason: string): void => {
    if (!owns()) return
    importState.failedCount++
    importState.failures.push({ relPath, reason })
    if (importState.failures.length > MAX_FAILURES) importState.failures.shift()
  }

  const raw = await collectSourceFiles(opts.sourceDir)
  const assets = groupByPair(raw)

  // exiftool 可用性懒判定：本次导入没有任何需要补写的文件时，不启动常驻进程
  let exifReady: boolean | null = null
  const ensureExifReady = async (): Promise<boolean> => {
    if (exifReady === null) exifReady = await isExifToolAvailable()
    return exifReady
  }

  /**
   * 落位成功后补写拍摄时间（只对 JPEG，且仅当本次日期不是来自 0x9003）。
   *
   * 补写失败不记入 failedCount：文件已经成功落位、能被扫描入库，只是少了一层日期固化；
   * 混进「失败清单」会让用户以为照片没导进来。单独用 exifFailed 计数并在完成文案里提示。
   *
   * 审查 C-13：两种「不正常」要分开记，否则用户看到的都是「导入完成」：
   *   - exiftool 不可用 → exifSkipped（一张都没补，但界面必须说出来）
   *   - mtime 还原失败 → exifMtimeFailed（判重键已损坏，后果比补写失败严重）
   */
  const patchExif = async (targetPath: string, date: ResolvedDate): Promise<void> => {
    try {
      if (!(await ensureExifReady())) {
        if (owns()) importState.exifSkipped++
        return
      }
      await writeDateTaken(targetPath, date.iso)
      if (owns()) importState.exifPatched++
    } catch (err) {
      if (owns()) {
        if (err instanceof MtimeRestoreError) importState.exifMtimeFailed++
        else importState.exifFailed++
      }
      console.warn(`[import] 补写拍摄时间失败 ${targetPath}: ${(err as Error).message}`)
    }
  }

  // 被新任务接管：一个字节的状态都不写，全部交给持有令牌的那个流水线
  if (!owns()) return { cancelled: true, message: '' }

  let total = 0
  for (const a of assets) total += 1 + (a.liveVideo ? 1 : 0)
  // 注：status='running' 由编排层（import/index.ts）在启动时设置，这里只更新阶段与进度计数
  importState.phase = 'copying'
  importState.totalFiles = total
  importState.processedFiles = 0
  importState.skipped = 0
  importState.exifPatched = 0
  importState.exifFailed = 0
  importState.failedCount = 0
  importState.failures = []
  // 归置前就失败的条目（上传阶段写盘失败）并进同一份清单（C-11）
  if (opts.seedFailures && opts.seedFailures.length > 0) {
    importState.failures = opts.seedFailures.slice(-MAX_FAILURES)
    importState.failedCount = opts.seedFailures.length
  }
  importState.startedAt = new Date().toISOString()
  importState.message = '正在导入…'

  let processed = 0
  for (const asset of assets) {
    if (stopped()) break
    const parts = [asset.image, asset.liveVideo].filter((f): f is RawImportFile => f !== null)
    // 以主资产（图片/独立视频）的日期为准，实况视频跟随进同一日期目录（保证同目录不拆散）
    const date = await resolveDate(asset.image.absPath, asset.image.kind)
    if (!date) {
      for (const f of parts) recordFailure(f.relPath, '无法确定拍摄日期（元数据与文件信息均不可读）')
      processed += parts.length
      if (owns()) importState.processedFiles = processed
      continue
    }
    const ymd = dateToDir(date.iso)
    const dayDir = path.join(opts.targetRoot, ymd)

    for (const f of parts) {
      if (stopped()) break
      try {
        // 审查 C-08：建目录放在 per-file try 里。旧实现放在循环外的资产循环顶部，
        // 目标盘满 / 目录被占用时异常会直接冲到编排层 → status='error'，
        // 剩下的所有资产一个都不再处理，也不进失败清单。
        // 放进来以后同样的故障只影响当天这一批文件，且每个文件各自记一条原因。
        fs.mkdirSync(dayDir, { recursive: true })
        const { targetPath, skipped } = pickTargetName(opts.targetRoot, ymd, f.fileName, f.mtimeMs)
        if (skipped) {
          if (owns()) importState.skipped++
        } else if (opts.mode === 'copy') {
          await copyAtomically(f.absPath, targetPath)
        } else {
          await moveFileCrossSafe(f.absPath, targetPath)
        }
        // 补写在落位之后：此时文件已归位，写失败也不会污染源文件；skipped 的不补（上次已补过）
        if (!skipped && isPatchableImage(f.fileName) && date.source !== 'exif-datetime') {
          await patchExif(targetPath, date)
        }
      } catch (err) {
        recordFailure(f.relPath, (err as Error).message)
      }
      processed++
      if (owns()) importState.processedFiles = processed
    }
    // 每处理若干资产让出一次事件循环，避免大目录导入期间阻塞 HTTP 轮询
    if (processed % 10 === 0) await yieldToEventLoop()
  }

  // 终态不在这里写（C-06）：落库扫描还没跑，此刻写 done 等于告诉前端「照片都在了」，
  // 而库里其实一行都没有。只把结果交给编排层，由它在 runScan 之后统一写终态。
  //
  // 被接管时连结果都不许碰（C-01）：旧流水线返回什么，新任务的状态都不该受影响。
  if (!owns()) return { cancelled: true, message: '' }
  const cancelled = isImportCancelRequested()
  return { cancelled, message: cancelled ? '已取消' : importDoneMessage() }
}

/**
 * 完成文案：把补写结果带上，否则「静默改写文件」用户无从感知。
 * 导出供单测直接验证四种降级分支的文案（用户唯一能看到的说明就在这里）。
 */
export function importDoneMessage(): string {
  const parts: string[] = []
  if (importState.exifPatched > 0) parts.push(`已补写拍摄时间 ${importState.exifPatched} 个`)
  if (importState.exifSkipped > 0) parts.push(`未补写 ${importState.exifSkipped} 个（缺少 exiftool）`)
  if (importState.exifFailed > 0) parts.push(`补写失败 ${importState.exifFailed} 个`)
  // 单独一条：后果不同（判重键损坏 → 重复导入会多出副本），不能和「补写失败」混为一谈
  if (importState.exifMtimeFailed > 0) {
    parts.push(`mtime 还原失败 ${importState.exifMtimeFailed} 个（重复导入可能多出副本）`)
  }
  return parts.length > 0 ? `导入完成（${parts.join('，')}）` : '导入完成'
}
