/**
 * 进程收尾（审查 C-16）
 *
 * 为什么单独成文件：这段逻辑必须在「Ctrl+C / kill / 未捕获异常」三条完全不同的入口复用，
 * 且要能被单测直接调用（index.ts 是服务入口，测试里加载它会真的监听端口）。
 *
 * 为什么必须做：开发时后端是 `tsx watch`，每次保存代码都会重启进程，日常重启也一样。
 * 没有收尾时每次重启都会留下：
 *   - icloudpd 子进程：PyInstaller 派生了真实子进程，父进程被杀后它继续占着 8080 与
 *     cookie 目录，下一次认证会连上这个旧会话（表现为「没输密码就跳到验证码」）
 *   - exiftool 常驻进程：导入补写用它，进程池不会自己退
 *   - 未 checkpoint 的 SQLite WAL：-wal/-shm 残留，下次打开要回放
 *   - 跑到一半的同步/导入：没人写终态，临时目录与 state 停在中间态
 *
 * ⚠️ 平台限制（别指望它解决所有场景）：
 *   - Windows 上 Node 只支持 SIGINT（Ctrl+C）与 SIGBREAK，SIGTERM 注册了也永远不会触发
 *   - `tsx watch` 重启子进程在 Windows 走 TerminateProcess，不会触发任何 handler
 *   真正兜住「重启残留」的是这里（用户主动 Ctrl+C）+ auth.ts 的 killResidualIcloudpd()
 *   （下次认证前清掉占着 8080 的旧 icloudpd）。
 */
import type { FastifyInstance } from 'fastify'
import { stopWatcher } from './scanner/watcher.js'
import { cancelImport } from './import/index.js'
import { isImportBusy } from './import/state.js'
import { cancelSync } from './icloudpd/sync.js'
import { stopAuth } from './icloudpd/auth.js'
import { closeExifTool } from './metadata/exifWrite.js'
import { clearThumbnailQueue } from './pipeline/queue.js'
import { closeDb } from './db/index.js'

/** 只依赖 close()，便于测试传一个假 app */
type ClosableApp = Pick<FastifyInstance, 'close'>

let shuttingDown = false

/**
 * 执行一次收尾。
 *
 * 顺序有讲究：先停「会产生新工作」的（watcher），再中止正在跑的，最后关连接。
 * 每步单独 try —— 任何一步失败都不能拦住后面的收尾，否则等于没做。
 *
 * @returns 是否真的执行了收尾（重复调用返回 false）
 */
export async function shutdown(app: ClosableApp, reason: string): Promise<boolean> {
  if (shuttingDown) return false
  shuttingDown = true
  console.log(`[shutdown] 收到 ${reason}，正在收尾…`)

  // 兜底：某一步卡住（taskkill 无响应 / 子进程不退）时 5 秒后强制退出，
  // 否则 Ctrl+C 之后进程吊着不走，用户只能去任务管理器杀
  const hardExit = setTimeout(() => {
    console.error('[shutdown] 收尾超时（5 秒），强制退出')
    process.exit(1)
  }, 5000)
  hardExit.unref()

  const step = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      console.error(`[shutdown] ${name} 失败: ${(err as Error).message}`)
    }
  }

  // ① 先停监听：否则收尾动作（删临时文件、清队列）会反过来触发新事件与新扫描
  await step('停止目录监听', () => stopWatcher())
  // ② 中止在跑的任务：导入会继续写库、同步会继续写 cookie
  await step('取消导入', () => {
    if (isImportBusy()) cancelImport()
  })
  await step('取消同步', () => cancelSync())
  // ③ 杀外部常驻进程：icloudpd 要整棵进程树，exiftool 要走协议退出
  await step('停止认证进程', () => stopAuth())
  await step('关闭 exiftool', () => closeExifTool())
  // ④ 丢弃内存里的缩略图队列（缓存文件是 .tmp + rename 原子写的，不会留半张图）
  await step('清空缩略图队列', () => clearThumbnailQueue())
  // ⑤ 关 HTTP 与数据库（closeDb 会 checkpoint WAL）
  await step('关闭 HTTP 服务', () => app.close())
  await step('关闭数据库', () => closeDb())

  clearTimeout(hardExit)
  console.log('[shutdown] 收尾完成')
  return true
}

/** 仅供测试：重置「已收尾」标记（同一个测试文件里要跑多次收尾） */
export function __resetShutdownForTest(): void {
  shuttingDown = false
}
