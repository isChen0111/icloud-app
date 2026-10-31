/**
 * 「导入本地照片目录」类型定义
 *
 * 功能边界（2026-10-30）：把用户自己维护的、结构多样的本地照片目录，按统一规范
 * （YYYY/MM/DD）迁移进项目照片库的 import/ 子目录，与 icloudpd 下载的 icloud/ 子目录
 * 物理隔离、逻辑统一浏览。导入不对源文件做任何改动（不改名、不改元数据、不转码），
 * 只改存放位置；默认复制，可选「导入后删除源文件」。
 */

/** 导入模式：copy = 保留源文件；move = 导入成功后删除源文件 */
export type ImportMode = 'copy' | 'move'

/** 导入来源：local = 后端运行机器本地目录；upload = 其他设备浏览器上传 */
export type ImportSource = 'local' | 'upload'

/** 导入任务状态机（仿 scanner 的 scanProgress） */
export type ImportStatus = 'idle' | 'running' | 'done' | 'error' | 'cancelled'

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
  /** 目标库 id（仅激活库可导入） */
  libraryId: number
  source: ImportSource
  mode: ImportMode
  message: string
  /** 待处理文件总数（实况配对的主资产 + 配对视频都计入） */
  totalFiles: number
  /** 已完成文件数（含跳过） */
  processedFiles: number
  /** 同名且 size+mtime 相同 → 视为已导入而跳过的数量 */
  skipped: number
  failedCount: number
  /** 失败清单（环形缓冲，最多保留最近 200 条） */
  failures: ImportFailure[]
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
