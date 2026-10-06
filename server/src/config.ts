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
  cacheDir: process.env.CACHE_DIR ?? path.join(projectRoot, 'server', 'cache'),

  /** SQLite 数据库文件位置（支持环境变量覆盖，测试隔离/多实例部署用） */
  dbPath: process.env.DB_PATH ?? path.join(projectRoot, 'server', 'cache', 'library.db'),

  /** BtbN ffmpeg full 解压目录（含 libheif；postinstall 下载）。可用 FFMPEG_DIR 覆盖 */
  ffmpegDir: process.env.FFMPEG_DIR ?? path.join(projectRoot, 'server', 'vendor', 'ffmpeg-full'),

  /** 缩略图尺寸档位（对标 iCloud 的 derivativeMSL 分级思想） */
  thumbSizes: {
    /** 网格缩略图：最长边 320px，覆盖全部缩放级别（对标 iCloud 415px 档） */
    grid: 320,
    /** 详情大图：最长边 1600px（对标 iCloud 2048px 档，本地够用） */
    detail: 1600,
  } as const,

  /** 缩略图质量（WebP） */
  thumbQuality: { grid: 80, detail: 82 } as const,

  /** 后台补图与用户请求共享的预览图最大并发数 */
  thumbConcurrency: 8,

  /** 视频封面抽取时间点（秒） */
  videoPosterSeek: 1,

  /**
   * FFmpeg 子进程超时（毫秒，修复审查 F-07）：
   * HEIC 解码 / 视频抽帧用；超时 kill 子进程并等待退出，防止卡死任务永久占住队列槽位。
   * 正常解码/抽帧为秒级~10 秒级，60s 为保守上限，不会误杀正常任务。
   */
  ffmpegTimeoutMs: 60_000,

  /** FFprobe 子进程超时（毫秒，修复审查 F-07）：读元数据/尺寸用；卡死直接 kill。 */
  ffprobeTimeoutMs: 30_000,

  /** 分页默认每页条数 */
  pageSize: 100,

  /** 扫描上限（调试/验证用）：>0 时只扫描前 N 个文件；0 = 全量 */
  scanLimit: Number(process.env.SCAN_LIMIT ?? 0),
}
