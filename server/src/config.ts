/**
 * 全局配置
 *
 * 所有可调参数集中在这里，方便学习与调试。
 * 三个路径类配置均可通过环境变量覆盖（如 PHOTO_LIBRARY=D:/photos），
 * 默认值按本项目约定自动推导：server 目录的上一级是项目根。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 当前文件（config.ts）所在目录 → server/src */
const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** 项目根：server/src/../.. = F:\iPhone\icloud-app */
const projectRoot = path.resolve(__dirname, '../..')

export const config = {
  /** 后端监听端口 */
  port: Number(process.env.PORT ?? 8899),

  /** 照片库根目录（iCloudPD 输出，只读）：默认 F:\iPhone\icloud-app\iCloudPhoto */
  libraryRoot: process.env.PHOTO_LIBRARY ?? path.join(projectRoot, 'iCloudPhoto'),

  /** 缓存目录：缩略图 / 视频封面 / 转码产物都放这里（可随时删除重建） */
  cacheDir: path.join(projectRoot, 'server', 'cache'),

  /** SQLite 数据库文件位置 */
  dbPath: path.join(projectRoot, 'server', 'cache', 'library.db'),

  /** 缩略图尺寸档位（对标 iCloud 的 derivativeMSL 分级思想） */
  thumbSizes: {
    /** 网格缩略图：最长边 320px，覆盖全部缩放级别（对标 iCloud 415px 档） */
    grid: 320,
    /** 详情大图：最长边 1600px（对标 iCloud 2048px 档，本地够用） */
    detail: 1600,
    /** 模糊占位图：极小尺寸 + 高斯模糊，滚动时秒出 */
    blur: 32,
  } as const,

  /** 缩略图质量（WebP） */
  thumbQuality: { grid: 80, detail: 82, blur: 60 } as const,

  /** 缩略图生成并发数（sharp 是 CPU/IO 混合任务，4~6 较稳） */
  thumbConcurrency: 8,

  /** 视频封面抽取时间点（秒） */
  videoPosterSeek: 1,

  /** 分页默认每页条数 */
  pageSize: 100,

  /** 扫描上限（调试/验证用）：>0 时只扫描前 N 个文件；0 = 全量 */
  scanLimit: Number(process.env.SCAN_LIMIT ?? 0),
}
