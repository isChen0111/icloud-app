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
import { spawn, type ChildProcess } from 'node:child_process'
import { config } from '../config.js'
import type { LibraryRow } from '../db/libraries.js'
import { touchLibrarySync, updateLibraryAuth } from '../db/libraries.js'
import { syncState, resetSyncState } from './state.js'
import { checkAuthValid } from './auth.js'

/** 索引未完成重试：等待 60s，最多 5 次（含首次后的 4 次） */
const RETRY_WAIT_MS = 60_000
const MAX_RETRIES = 5
const INDEX_NOT_READY = /has not finished indexing/i
/** icloudpd 原始输出环形缓冲上限（行） */
const MAX_LOG_LINES = 500

let proc: ChildProcess | null = null
let retryTimer: NodeJS.Timeout | null = null
let retries = 0

function clearTimers(): void {
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
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
      spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' })
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
  if (!lib.account) {
    return { ok: false, message: '该库尚未链接 iCloud，请先认证' }
  }
  currentLibRef = lib
  // 同步前预检 cookie 有效性（后台异步）：无效 → 标记 expired（前端提示重新链接）；
  // 不阻塞任务启动，真实结果以进程输出为准（会话失效时进程会报错，见 handleLine）
  void checkAuthValid(lib.account, lib.cookie_dir).then((result) => {
    if (currentLibRef?.id === lib.id) {
      updateLibraryAuth(lib.id, { auth_status: result.valid ? 'authed' : 'expired' })
    }
  })

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
    '--directory', lib.library_root,
    '--domain', 'cn',
    '--cookie-directory', lib.cookie_dir,
    '--set-exif-datetime',
  ]
  if (kind === 'inc') args.push('--until-found', String(Math.max(1, lib.until_found || 20)))
  // 下载限量：库配置 recent_limit（0=全量不限）；环境变量仅作兜底（库配置 > 环境变量）
  const recent = lib.recent_limit > 0 ? lib.recent_limit : config.icloudpdRecent
  if (recent > 0) args.push('--recent', String(recent))

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
    syncState.status = 'error'
    syncState.message = `无法启动 icloudpd：${err.message}`
    syncState.finishedAt = new Date().toISOString()
    proc = null
  })

  child.on('exit', (code) => {
    proc = null
    if (syncState.status === 'cancelled') return // 用户取消，不覆盖状态
    if (syncState.status === 'waiting_retry') return // 重试定时器已接管
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
  })
}

/** 单行输出处理：原始行记入日志缓冲 / 进度计数 / 索引未完成重试 */
function handleLine(line: string): void {
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
