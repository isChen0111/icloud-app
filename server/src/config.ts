/**
 * 全局配置
 *
 * 所有可调参数集中在这里，方便学习与调试。
 * 默认值按本项目约定自动推导：server 目录的上一级是项目根。
 *
 * ⚠️ 照片库 / 缓存 / 数据库三类路径**不支持环境变量覆盖**（2026-11-01 移除 PHOTO_LIBRARY /
 * CACHE_DIR / DB_PATH / META_DB_PATH）：
 * - 多照片库后，每库的照片目录、cache、cookie、library.db、注册表 meta.db 通过绝对路径紧密绑定；
 * - 单独用 env 把其中一项指到别处，会造成「注册表在一处、库文件在另一处」的半迁移状态，
 *   建库时也无法可靠派生新库路径（config.libraryRoot 运行时会指向当前激活库，见 context.ts）；
 * - 库路径统一由建库时按项目根派生并写入 meta.db，运行期再读回来（applyLibraryPaths）。
 * 端口、vendor 二进制、调试开关等与库无关的参数仍支持环境变量覆盖。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 当前文件（config.ts）所在目录 → server/src */
const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** 项目根：server/src/../.. = F:\iPhone\icloud-app */
const projectRoot = path.resolve(__dirname, '../..')

/** 导出项目根（建库/路径派生等场景直接引用，避免按 metaDb 层级推导出错） */
export { projectRoot }

export const config = {
  /** 后端监听端口 */
  port: Number(process.env.PORT ?? 8899),

  /**
   * 后端监听地址：默认 0.0.0.0（同一局域网设备可访问，配合同源 Origin 判定）。
   * 仅本机访问可设 127.0.0.1（外部设备连接被拒）。
   */
  host: process.env.HOST ?? '0.0.0.0',

  /**
   * 照片库根目录：无库时的占位值；有库后由 context.applyLibraryPaths()
   * 覆写为激活库的 library_root（本字段是运行时上下文，不是配置常量，勿用于派生新库路径）。
   */
  libraryRoot: path.join(projectRoot, 'iCloudPhoto'),

  /** 缓存目录（同上，运行时被激活库的 cache_dir 覆写） */
  cacheDir: path.join(projectRoot, 'server', 'cache'),

  /** 激活库 SQLite 数据库文件（同上，运行时被覆写） */
  dbPath: path.join(projectRoot, 'server', 'cache', 'library.db'),

  /**
   * 库注册表 DB（应用级，多库共享一份；固定放 server/cache 根，不随激活库切换）。
   * 记录每个照片库的 名称/根目录/cache 目录/cookie 目录/账号/同步状态/激活标记。
   * 随 cache 清理重建 = 重新注册库，可接受。
   */
  metaDbPath: path.join(projectRoot, 'server', 'cache', 'meta.db'),

  /**
   * icloudpd 可执行文件（黑盒调用，版本锁定）。
   * 默认取 server/vendor 目录（与 ffmpeg 同放 vendor，统一第三方二进制）。
   * 其他机器可用 ICLOUDPD_EXE 覆盖。
   */
  icloudpdExe: process.env.ICLOUDPD_EXE ?? path.join(projectRoot, 'server', 'vendor', 'icloudpd-1.32.3-windows-amd64.exe'),

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

  /**
   * 热监听派发扫描的最小间隔（毫秒，0 = 关闭闸门）。
   *
   * 防抖只能合并「静默前」的那一波事件；同步下载/手动拷贝持续写入时，事件一波接
   * 一波，扫描会一轮接一轮连着跑（每轮都是全库遍历 + stat）。给个下限后节奏可控。
   * 只约束 watcher 自己派发的扫描，手动/导入扫描不受影响。
   */
  scanMinIntervalMs: Number(process.env.SCAN_MIN_INTERVAL_MS ?? 5000),

  /**
   * 导入归置期间派发周期扫描的最小「新增文件数」（0 = 关闭周期扫描）。
   *
   * 两个阈值是「且」的关系：时间控节奏，文件数只防「一两个文件也扫一轮全库」。
   * 单看文件数会被快盘绕过（几秒触发一次，照片墙反复重建）；单看时间又会做无用扫描。
   */
  importScanEveryFiles: Number(process.env.IMPORT_SCAN_EVERY_FILES ?? 100),

  /**
   * 导入归置期间两次周期扫描的最小间隔（毫秒）。
   *
   * 20 秒是「首图尽快出现」与「别和拷贝抢 IO」之间的折中：60 秒意味着用户对着空墙
   * 等一分钟，边导边看的意义就没了；太密则每轮全库遍历会和 fs.cp 争盘。
   */
  importScanMinIntervalMs: Number(process.env.IMPORT_SCAN_MIN_INTERVAL_MS ?? 20_000),

  /**
   * 单文件上传大小上限（字节），供「导入本地目录」的远程上传使用。
   * 0 = 不限（默认）；可用 MAX_UPLOAD_BYTES 覆盖，防止误传超大文件。
   * ⚠️ 「不限」在 index.ts 里必须显式转成 Infinity（不能传 undefined，否则
   *   @fastify/multipart 会回落到 Fastify bodyLimit 1 MiB，正常照片都会 413）。
   */
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 0),
}
