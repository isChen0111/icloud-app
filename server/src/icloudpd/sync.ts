/**
 * icloudpd 下载任务（全量 / 增量）
 *
 * 命令形态与用户已验证的 bat 完全一致（默认 download 模式，Copy 不删云端）：
 *   全量：<exe> --username <账号> --directory <库根> --domain cn
 *              --cookie-directory <库cookie目录> [--set-exif-datetime]
 *   增量：全量 + --until-found 20
 *
 * 健壮性（架构文档 §3.1.5）：
 *   - 索引未完成：输出含 has not finished indexing → 等待 60s 自动重试（最多 5 次），
 *     期间状态 waiting_retry，前端可见；期间可手动取消。
 *   - 取消：kill 子进程（含进程树），标记 cancelled。
 *   - 断网/进程异常退出 → error，用户可再次执行（增量续传）。
 *   - 进度：行模式 Downloading… / Downloaded… 计数（近似），不做精确条目解析。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { config } from '../config.js'
import type { LibraryRow } from '../db/libraries.js'
import { touchLibrarySync, updateLibraryAuth, libraryIcloudDir } from '../db/libraries.js'
import { syncState, resetSyncState } from './state.js'
import { cookieExists } from './auth.js'

/** 索引未完成重试：等待 60s，最多 5 次（含首次后的 4 次） */
const RETRY_WAIT_MS = 60_000
const MAX_RETRIES = 5
const INDEX_NOT_READY = /has not finished indexing/i
/** icloudpd 原始输出环形缓冲上限（行） */
const MAX_LOG_LINES = 500

let proc: ChildProcess | null = null
let retryTimer: NodeJS.Timeout | null = null
let retries = 0

/** 清理重试定时器（导出供单元测试在 after 钩子中清理残留 timer） */
export function clearTimers(): void {
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
}

/** 重置索引重试计数（startSync 正常路径也会重置；导出供单元测试隔离用例状态） */
export function resetRetries(): void {
  retries = 0
}

/** 当前是否有同步任务在跑/在等重试 */
export function isSyncBusy(): boolean {
  return syncState.status === 'running' || syncState.status === 'waiting_retry'
}

/** 杀进程树（PyInstaller exe 有真实子进程，仅 kill 父进程会残留下载进程） */
function killProcess(): void {
  if (proc && !proc.killed) {
    const pid = proc.pid
    try {
      // 同步等待 taskkill 完成（审查 P3d）：确保旧进程树彻底退出后再允许新任务启动，
      // 避免取消/重试后立即重开时新旧 icloudpd 并发写同一库目录
      spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' })
    } catch {
      try {
        proc.kill()
      } catch {
        // 已退出
      }
    }
  }
  proc = null
}

/**
 * 启动同步任务。前置条件：该库已认证（account 非空且 cookie 有效）。
 * 一次仅允许一个同步任务；已有任务时返回当前状态并拒绝新任务。
 */
export function startSync(lib: LibraryRow, kind: 'full' | 'inc'): SyncTaskStateLike {
  if (isSyncBusy()) {
    return {
      ok: false,
      message: `已有任务在执行中（${syncState.libraryId === lib.id ? '本库' : '其他库'}），请等待或取消`,
    }
  }
  // F2（2026-11-03）：判据必须是「链接完成」，不能只看 account。
  // account 在 POST /api/auth 提交邮箱那一刻就写库了（用户刚提交完邮箱、还没过验证码），
  // 所以「account 有值 + auth_status='none'」= 点过登录但从未成功。
  // 旧实现只查 account，未登录的库也能启动全量拉取，而 icloudpd 拿着半成品 cookie
  // 会直接要验证码，日志看起来像是「cookie 没清干净」。
  if (!lib.account || lib.auth_status !== 'authed') {
    return {
      ok: false,
      message:
        lib.auth_status === 'expired'
          ? '该库的 iCloud 链接已过期，请重新登录后再同步'
          : '该库尚未完成 iCloud 链接，请先在设置中心登录后再同步',
    }
  }
  // F4：状态可能因历史数据/手工改动而不准，再确认一次主 cookie 真的在磁盘上。
  // 缺 cookie 却放行，只会白跑一个必然卡在登录的进程。
  if (!cookieExists(lib.cookie_dir)) {
    updateLibraryAuth(lib.id, { auth_status: 'expired' })
    return { ok: false, message: 'cookie 文件缺失（可能被清理或迁移过），请重新登录 iCloud 后再同步' }
  }
  currentLibRef = lib
  // R-10 修复（2026-10-28）：这里原先会再 spawn 一个 icloudpd 跑 checkAuthValid 做「同步前预检」，
  // 但它和主同步进程共用同一个 cookie 目录，两边都会回写 session token（可能把 cookie 写坏）；
  // 它不受取消控制（取消同步只杀主进程，预检进程仍在后台跑到 30s 超时）；
  // 它的结果还是异步写回的，可能覆盖主进程给出的更准确判断
  // （handleLine 检测到 session 过期会标 expired，随后被预检写回 authed）。
  // 会话是否有效一律以主同步进程的输出为准（见 handleLine 的 expired 分支），
  // checkAuthValid 保留给未来的「启动时巡检」，不在同步流程里调用。

  resetSyncState()
  syncState.status = 'running'
  syncState.libraryId = lib.id
  syncState.kind = kind
  syncState.message = kind === 'full' ? '全量拉取开始…' : '增量同步开始…'
  syncState.startedAt = new Date().toISOString()
  retries = 0
  spawnOnce(lib, kind)
  return { ok: true, message: '已启动' }
}

/** 真正 spawn 一次下载进程 */
function spawnOnce(lib: LibraryRow, kind: 'full' | 'inc'): void {
  const args = [
    '--username', lib.account!,
    '--directory', libraryIcloudDir(lib.library_root),
    '--domain', 'cn',
    '--cookie-directory', lib.cookie_dir,
    '--set-exif-datetime',
  ]
  if (kind === 'inc') args.push('--until-found', String(Math.max(1, lib.until_found || 20)))
  // 下载限量：仅库配置 recent_limit > 0 时追加 --recent；0 = 全量不限。
  // 不再读 .env ICLOUDPD_RECENT（已废弃，统一在设置中心按库配置）
  if (lib.recent_limit > 0) args.push('--recent', String(lib.recent_limit))

  const child = spawn(config.icloudpdExe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  proc = child
  syncState.pid = child.pid ?? null
  let buffer = ''

  const onData = (chunk: Buffer): void => {
    buffer += chunk.toString('utf8')
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      handleLine(line)
    }
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)

  child.on('error', (err) => {
    // 归属校验（审查 C-04）：已被取消/被新任务取代的旧进程，它的 error 不得改写状态
    if (proc !== child) return
    syncState.status = 'error'
    syncState.message = `无法启动 icloudpd：${err.message}`
    syncState.finishedAt = new Date().toISOString()
    proc = null
  })

  // 归属校验（审查 C-04）：把 child 一并传下去，由 handleSyncExit 首行比对。
  // 只写 `proc !== child` 在这里也能拦住，但放进被单测覆盖的函数里才能防止「守卫被改反」。
  child.on('exit', (code) => handleSyncExit(code, lib, child))
}

/**
 * 子进程退出后的终态处理（抽出为独立函数便于单元测试，审查 P3a/P3b）：
 * - cancelled：用户取消，不覆盖状态；
 * - waiting_retry：重试定时器已接管，不覆盖；
 * - error：终态（会话失效/重试耗尽已给出具体文案并结束任务）。进程随后退出
 *   （被杀或自行退出）不得再覆盖为通用异常或 done，防止：
 *     ① 具体文案（"会话已过期请重新链接"）被"icloudpd 异常退出"冲掉；
 *     ② 重试耗尽后进程自行退出 0 时 error→done 翻转并错误更新 last_sync_at
 *
 * @param child 触发本次退出的子进程。传了就做归属校验（审查 C-04）：`proc` 已经不是它，
 *   说明这个进程被取消或被新任务取代了，它的退出不得改任何状态 —— 否则「取消后立刻再点
 *   同步」时，旧进程迟到的 exit 会把新任务写成 error，用户再点一次就出现两个 icloudpd
 *   同时写同一库目录（代码注释里最担心的场景）。auth.ts 的认证进程早就有这道校验（R-09），
 *   同步侧一直漏着。
 */
export function handleSyncExit(code: number | null, lib: LibraryRow, child?: ChildProcess): void {
  if (child && proc !== child) return
  proc = null
  if (syncState.status === 'cancelled') return // 用户取消，不覆盖状态
  if (syncState.status === 'waiting_retry') return // 重试定时器已接管
  if (syncState.status === 'error') {
    if (currentLibRef?.id === lib.id) currentLibRef = null
    return
  }
  if (code === 0) {
    syncState.status = 'done'
    syncState.message = '同步完成'
    syncState.finishedAt = new Date().toISOString()
    touchLibrarySync(lib.id)
    updateLibraryAuth(lib.id, { auth_status: 'authed' })
  } else {
    syncState.status = 'error'
    syncState.message = `icloudpd 异常退出（code=${code}）。网络中断或会话失效时请重试（增量可续传）`
    syncState.finishedAt = new Date().toISOString()
  }
  if (currentLibRef?.id === lib.id) currentLibRef = null
}

/** 单行输出处理：原始行记入日志缓冲 / 进度计数 / 索引未完成重试（导出供单元测试） */
export function handleLine(line: string): void {
  // 原始输出先进日志（任何状态都记：running / waiting_retry / 重试过程都能看到）
  const raw = line.replace(/\r/g, '').trim()
  if (raw) {
    syncState.log.push(raw)
    if (syncState.log.length > MAX_LOG_LINES) {
      syncState.log.splice(0, syncState.log.length - MAX_LOG_LINES)
    }
  }
  if (syncState.status !== 'running') return
  const text = line.trim()

  // 下载计数：匹配 "Downloading F:\...\xxx.JPG" 单文件行（行首有时间戳+级别，不能锚定 ^）。
  // 排除总计行 "Downloading N original photos"（后面跟数字不是盘符，自然不匹配）。
  // 排除总结句 "All photos and videos have been downloaded"（不含 "Downloading X:\"）。
  if (/downloading\s+[a-z]:[\\/]/i.test(text)) {
    syncState.downloaded += 1
    syncState.message = `已下载 ${syncState.downloaded} 项`
  } else if (/^downloading/i.test(text)) {
    syncState.message = '正在下载…'
  }

  // Apple 端索引未完成：等待后自动重试（最多 5 次）
  if (INDEX_NOT_READY.test(text)) {
    if (retries < MAX_RETRIES) {
      retries += 1
      syncState.status = 'waiting_retry'
      syncState.message = `iCloud 索引尚未就绪（第 ${retries}/${MAX_RETRIES} 次），60 秒后自动重试…`
      if (proc && !proc.killed) {
        killProcess()
      }
      proc = null
      clearTimers()
      retryTimer = setTimeout(() => {
        retryTimer = null
        if (syncState.status === 'cancelled') return
        const lib = currentLibRef
        if (!lib) return
        syncState.status = 'running'
        syncState.message = `自动重试（${retries}/${MAX_RETRIES}）…`
        spawnOnce(lib, syncState.kind)
      }, RETRY_WAIT_MS)
    } else {
      syncState.status = 'error'
      syncState.message = 'iCloud 索引长时间未就绪（已重试 5 次），请稍后再试'
      syncState.finishedAt = new Date().toISOString()
      // 审查 P3b：进程仍在跑（可能自行完成或挂起等待输入），须杀掉避免后台残留，
      // 且后续 exit 事件因 status==='error' 不再改判状态
      if (proc && !proc.killed) {
        killProcess()
      }
      proc = null
    }
  }

  // 会话失效（下载时偶尔直接输出）
  if (/authentication required|session.*expired|logged out|重新登录/i.test(text)) {
    if (currentLibRef) updateLibraryAuth(currentLibRef.id, { auth_status: 'expired' })
    syncState.status = 'error'
    syncState.message = 'iCloud 会话已过期，请重新链接后再同步'
    syncState.finishedAt = new Date().toISOString()
    killProcess()
  }
}

/** 重试逻辑需要访问当前库信息（exit 回调里 lib 变量已随闭包过期，此处保存引用） */
let currentLibRef: LibraryRow | null = null

/** 取消同步任务 */
export function cancelSync(): void {
  clearTimers()
  killProcess()
  if (syncState.status === 'running' || syncState.status === 'waiting_retry') {
    syncState.status = 'cancelled'
    syncState.message = '任务已取消'
    syncState.finishedAt = new Date().toISOString()
  }
  currentLibRef = null
}

export type SyncTaskStateLike = { ok: boolean; message: string }
