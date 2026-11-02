/**
 * 「导入本地照片目录」类型定义
 *
 * 功能边界（2026-10-30，2026-11-01 修订）：把用户自己维护的、结构多样的本地照片目录，
 * 按统一规范（YYYY/MM/DD）迁移进项目照片库的 import/ 子目录，与 icloudpd 下载的 icloud/
 * 子目录物理隔离、逻辑统一浏览。**源文件**不做任何改动（不改名、不改元数据、不转码）；
 * 但落位到库内的副本会补写拍摄时间——缺 0x9003 的 JPEG 会把导入时确定的日期写进
 * EXIF（见 metadata/exifWrite.ts），这是当前唯一会改写文件内容的环节，且只发生于副本。
 * 默认复制，可选「导入后删除源文件」。
 */

/** 导入模式：copy = 保留源文件；move = 导入成功后删除源文件 */
export type ImportMode = 'copy' | 'move'

/** 导入来源：local = 后端运行机器本地目录；upload = 其他设备浏览器上传 */
export type ImportSource = 'local' | 'upload'

/** 导入任务状态机（仿 scanner 的 scanProgress） */
export type ImportStatus = 'idle' | 'running' | 'done' | 'error' | 'cancelled'

/**
 * 导入的阶段（审查 C-06）。
 *
 * `status` 表达的是「整个任务」的终态，而一次导入实际分两段：
 *   ① copying  —— 归置文件到 import/YYYY/MM/DD（可取消）
 *   ② scanning —— runScan 遍历落库（不可取消）
 *
 * 旧实现归置结束就写 `status='done'`，前端立刻停轮询 + 刷新统计，可此刻库里一行都没有
 * （落库扫描在后面，要几秒到几十秒），用户看到「导入完成」却是一片空白的照片墙。
 * 现在终态推迟到 scanning 结束后才写，中间用 phase + message 说明正在做什么。
 */
export type ImportPhase = 'idle' | 'copying' | 'scanning'

/** 单个失败项（单文件失败不中断整体） */
export interface ImportFailure {
  /** 失败文件的源相对路径（相对用户目录 / 上传临时目录） */
  relPath: string
  /** 失败原因（中文简述） */
  reason: string
}

/** 导入进度（内存单例，随服务重启清空，仿 scanProgress/syncState） */
export interface ImportProgress {
  status: ImportStatus
  /** 当前处在归置阶段还是落库阶段（终态写回后复位为 idle） */
  phase: ImportPhase
  /** 目标库 id（仅激活库可导入） */
  libraryId: number
  source: ImportSource
  mode: ImportMode
  message: string
  /** 待处理文件总数（实况配对的主资产 + 配对视频都计入） */
  totalFiles: number
  /** 已完成文件数（含跳过） */
  processedFiles: number
  /** 同名且 mtime 相同 → 视为已导入而跳过的数量 */
  skipped: number
  /** 落位后成功补写拍摄时间（EXIF 0x9003/0x9004）的文件数 */
  exifPatched: number
  /** 补写失败数（不影响文件已落位入库，单独计数避免与 failedCount 混淆） */
  exifFailed: number
  failedCount: number
  /** 失败清单（环形缓冲，最多保留最近 200 条） */
  failures: ImportFailure[]
  /**
   * 是否已收到取消请求（审查 C-01）。
   * 注意与 status 的区别：取消只是信号，流水线可能正卡在某个大文件的 cp 上，
   * 要等它回到循环顶部才会退出。这段期间 status 仍是 'running'，前端据此显示
   * 「正在取消…」并禁用按钮，而不是让用户以为点击无效反复点。
   */
  cancelRequested: boolean
  startedAt: string | null
  finishedAt: string | null
}

/** 一次导入任务的参数 */
export interface ImportOptions {
  /** 目标库 id */
  libraryId: number
  /** 源目录（本机迁移 = 用户目录；上传 = 上传临时目录） */
  sourceDir: string
  /** 落库目标根（= libraryImportDir(lib.library_root)） */
  targetRoot: string
  mode: ImportMode
  source: ImportSource
}
