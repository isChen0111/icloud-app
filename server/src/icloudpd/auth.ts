/**
 * icloudpd 认证流程（网页端输入邮箱/密码/验证码 → 后端桥接 icloudpd 内嵌 webui 服务）
 *
 * 方案（架构文档 §3.1.1，P0 实测校正）：
 *   spawn `icloudpd --username <邮箱> --password-provider webui --mfa-provider webui
 *              --cookie-directory <库cookie目录> --domain cn --auth-only`
 *   → icloudpd 自起内嵌认证服务（监听 0.0.0.0:8080），交互走 HTTP，不依赖 stdin/stdout 管道
 *     （console 方案实测不可行：密码阶段 getpass 直读控制台，管道化进程挂起无提示）
 *   → 后端每 1s GET /status 解析当前阶段（密码表单 / 验证码表单 / 等待中）
 *   → 前端轮询 /api/auth 展示；/api/auth/input 由后端 POST /password 或 /code 转交
 *   → 完成判据：进程退出码 0 + cookie 落盘
 *   → 超时（10 分钟）强制结束。
 *
 * 安全：密码/验证码只经本机回环 HTTP 进入 icloudpd 内存；authSession 只存状态不存明文；
 *       不写日志、不落盘、不做任何持久化。
 */
import { execSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'

export type AuthStage = 'starting' | 'waiting_password' | 'waiting_code' | 'done' | 'error'

export interface AuthSession {
  stage: AuthStage
  /** 提示给前端展示的说明 */
  hint: string
  /** 完成/错误时的信息 */
  message: string
  cookieDir: string
}

/** icloudpd 内嵌 webui 服务（waitress 默认端口，实测 0.0.0.0:8080） */
const WEBUI_PORT = 8080
const WEBUI_BASE = `http://127.0.0.1:${WEBUI_PORT}`
/** 服务就绪/请求超时 */
const HTTP_TIMEOUT_MS = 3000
/** 状态轮询间隔 */
const POLL_INTERVAL_MS = 1000
/** 认证超时（架构文档 §3.1.1） */
const AUTH_TIMEOUT_MS = 10 * 60 * 1000

/** 当前认证会话（同一时间只允许一个） */
let session: AuthSession | null = null
let proc: ChildProcess | null = null
let authTimer: NodeJS.Timeout | null = null
let pollTimer: NodeJS.Timeout | null = null

/** 新建认证会话（导出供单元测试设置 session） */
export function newSession(cookieDir: string, stage: AuthStage, hint: string): AuthSession {
  session = { stage, hint, message: '', cookieDir }
  return session
}

/** 从 /status 或提交响应提取错误文本（bootstrap alert 或 hx-target-error 的 #toast-content），没有则返回 undefined */
function extractError(html: string): string | undefined {
  // 优先：表单上的 bootstrap alert（如「Incorrect password」）
  const alert = html.match(/<div[^>]*class="[^"]*\balert\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
  if (alert) {
    const text = alert[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
    if (text) return text
  }
  // 其次：hx-target-error 渲染的 #toast-content（验证码/密码错误提示）
  const toast = html.match(/id="toast-content"[^>]*>([\s\S]*?)<\/div>/i)
  if (toast) {
    const text = toast[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
    if (text) return text
  }
  return undefined
}

/** GET /status，解析当前需要什么输入；服务未就绪返回 null */
async function webuiStatus(): Promise<{ kind: 'password' | 'code' | 'other'; error?: string } | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
  try {
    const res = await fetch(`${WEBUI_BASE}/status`, { signal: controller.signal })
    if (!res.ok) return { kind: 'other' }
    const html = await res.text()
    if (/name="password"/.test(html)) return { kind: 'password', error: extractError(html) }
    if (/name="code"/.test(html)) return { kind: 'code', error: extractError(html) }
    return { kind: 'other' }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 轮询 webui 状态 → 同步到 session（进程退出或会话结束后停止） */
function startPolling(): void {
  stopPolling()
  pollTimer = setInterval(async () => {
    if (!session || session.stage === 'done' || session.stage === 'error') {
      stopPolling()
      return
    }
    const status = await webuiStatus()
    if (!session) return
    if (status === null) {
      // 服务未就绪：保持当前阶段，不打扰前端
      return
    }
    // 校验确认超时兜底：提交后长时间无进展（如 webui 校验卡死）→ 判失败解锁，防永久转圈
    if (submitPending && Date.now() - submitPendingSince > SUBMIT_PENDING_TIMEOUT_MS) {
      session.stage = 'error'
      session.message = '凭据校验超时（120 秒无进展），已停止。请关闭后重新链接'
      submitPending = false
      return
    }
    if (status.kind === 'password') {
      session.stage = 'waiting_password'
      session.hint = '请输入 Apple ID 密码（凭据仅本次使用，保存在本机 cookie 中）'
      // 进入密码输入阶段 = 上一提交已确认（解锁防重窗口，允许本次输入）
      submitPending = false
      if (status.error) session.message = status.error
    } else if (status.kind === 'code') {
      session.stage = 'waiting_code'
      session.hint = '请输入发送到设备的验证码（Apple 双重验证）'
      // 进入验证码输入阶段 = 密码校验已确认（解锁防重窗口，验证码才能提交成功）
      submitPending = false
      if (status.error) {
        session.message = status.error
      }
    } else {
      // NO_INPUT_NEEDED / 校验中：等进程退出判定。校验中保持 submitPending（拒绝重复提交）
      session.hint = '正在校验凭据，请稍候…'
    }
  }, POLL_INTERVAL_MS)
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

/** cookie 是否已落盘（存在非 .session 的 cookie 文件） */
function cookieExists(cookieDir: string): boolean {
  try {
    return fs
      .readdirSync(cookieDir)
      .some((f) => f.endsWith('.session') === false && !f.startsWith('.'))
  } catch {
    return false
  }
}

/**
 * 清理占用 8080 端口的残留 icloudpd 进程：
 * 后端被强杀/重启时，旧 icloudpd 子进程（--auth-only 内嵌服务）可能变成孤儿继续监听 8080。
 * 只杀进程名含 icloudpd 的（本模块专用服务），不动其他程序。
 */
function killResidualIcloudpd(): void {
  try {
    const out = execSync('netstat -ano -p tcp', { encoding: 'utf8' }) as string
    const line = out
      .split(/\r?\n/)
      .find((l) => new RegExp(`:${WEBUI_PORT}\\s+.*LISTENING`).test(l))
    if (!line) return
    const pid = Number.parseInt(line.trim().split(/\s+/).pop() ?? '', 10)
    if (!Number.isFinite(pid) || pid <= 0) return
    const task = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8' }) as string
    if (/icloudpd/i.test(task)) {
      spawnSync('taskkill', ['/F', '/PID', String(pid)])
      console.warn(`[auth] 已清理占用 ${WEBUI_PORT} 的残留 icloudpd 进程（PID ${pid}）`)
    }
  } catch {
    // 无监听/无权限/命令不可用：忽略（后续 spawn 失败会有退出码兜底）
  }
}

/** 开始认证（auth-only，仅换 cookie 不下载） */
export function startAuth(username: string, cookieDir: string): AuthSession {
  // 已存在会话则先清理
  stopAuth()
  submitPending = false
  // 清理端口残留：后端异常退出/重启时，旧 icloudpd 子进程可能变孤儿继续占着 8080，
  // 新认证若不清理会连上旧会话（如旧验证码表单），表现为「没输密码就跳到验证码」
  killResidualIcloudpd()

  fs.mkdirSync(cookieDir, { recursive: true })
  // starting = 内嵌认证服务尚未就绪：前端只展示「正在启动」，不出现密码/验证码输入框
  const s = newSession(cookieDir, 'starting', '正在启动认证服务…')
  session = s

  const args = [
    '--username', username,
    '--password-provider', 'webui',
    '--mfa-provider', 'webui',
    '--cookie-directory', cookieDir,
    '--domain', 'cn',
    '--auth-only',
  ]
  const child = spawn(config.icloudpdExe, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  proc = child

  // 捕获日志（仅排查用，不写入任何业务日志）
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})

  child.on('error', (err) => {
    if (!session) return
    session.stage = 'error'
    session.message = `无法启动 icloudpd：${err.message}`
  })
  child.on('exit', (code) => {
    stopPolling()
    if (!session) return
    // 无提示直接退 = 已有有效 cookie 或异常
    if (code === 0 && cookieExists(cookieDir)) {
      session.stage = 'done'
      session.message = '认证成功，cookie 已保存'
    } else if (code !== 0 && session.stage !== 'done') {
      session.stage = 'error'
      session.message = `icloudpd 认证退出（code=${code}）。常见原因：密码错误 / Apple 临时限流 / 认证服务端口被占用`
    }
    proc = null
  })

  // 等内嵌服务起来后开始轮询状态
  startPolling()

  authTimer = setTimeout(() => onAuthTimeout(), AUTH_TIMEOUT_MS)

  return s
}

/**
 * 认证超时处理（抽出为独立函数便于单元测试，审查 P3e）：
 * 先标记 error（前端轮询能读到"认证超时"文案），再清理进程/轮询；
 * 不能先 stopAuth()（session 会被置 null，超时文案变成死代码永不生效）。
 * teardownAuthProcess 保留 session 引用：error 状态供前端轮询读取。
 */
export function onAuthTimeout(): void {
  if (session) {
    session.stage = 'error'
    session.message = '认证超时（10 分钟），请重试'
  }
  teardownAuthProcess()
}

/** 提交防重锁：同一时刻只处理一次提交，避免并发/连点造成重复发验证请求（用户手机重复收到验证码） */
let inputLock = false
/**
 * 提交确认窗口：提交后置 true，轮询确认「需要新输入（密码/验证码错误）或进入下一步」才解锁。
 * 校验中（webui 显示 NO_INPUT_NEEDED）保持锁定——即使前端异常连发两次，第二次也会被拒，
 * 杜绝 Apple 重复收到登录提交、重复弹「允许」验证。
 */
let submitPending = false
/** 提交确认窗口起始时间（用于校验超时兜底） */
let submitPendingSince = 0
/** 校验确认最长等待：超过即判失败并解锁，防前端/后端永久转圈 */
const SUBMIT_PENDING_TIMEOUT_MS = 120 * 1000

/** 向 icloudpd 内嵌服务提交密码 / 验证码（按当前阶段选择端点） */
export async function sendAuthInput(value: string): Promise<AuthSession | null> {
  if (inputLock || submitPending) {
    if (submitPending) console.warn('[auth] 忽略重复提交（校验确认中，防止重复触发验证请求）')
    return session
  }
  inputLock = true
  try {
    if (!session || session.stage === 'done' || session.stage === 'error') {
      return session
    }
    const isCode = session.stage === 'waiting_code'
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
    try {
      const resp = await fetch(`${WEBUI_BASE}${isCode ? '/code' : '/password'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ [isCode ? 'code' : 'password']: value }),
        signal: controller.signal,
      })
      // 提交响应里带错误提示（如密码/验证码不正确）→ 立即报错并解锁，前端可重输
      const errText = extractError(await resp.text())
      if (errText) {
        if (session) {
          session.stage = isCode ? 'waiting_code' : 'waiting_password'
          session.message = errText
        }
        submitPending = false
      } else {
        // 无错误：进入确认窗口（轮询确认进入下一步或报错才解锁）
        submitPending = true
        submitPendingSince = Date.now()
      }
    } catch (err) {
      if (session) {
        session.stage = 'error'
        session.message = `提交失败：${(err as Error).message}`
      }
    } finally {
      clearTimeout(timer)
    }
    return session
  } finally {
    inputLock = false
  }
}

/** 查询当前认证状态（前端轮询） */
export function authStatus(): AuthSession | null {
  return session
}

/** 停止/清理当前认证进程（取消认证、换库、超时）。
 *  PyInstaller 打包的 exe 会派生真实子进程，仅 kill 父进程会残留；
 *  故用 taskkill /T 杀整个进程树（Windows）。 */
export function stopAuth(): void {
  teardownAuthProcess()
  session = null
}

/**
 * 清理认证进程/轮询/防重锁，但保留 session 引用（审查 P3e）：
 * 认证超时场景需先设置 error 状态供前端轮询读取，再清理进程；
 * 若先 stopAuth()（session=null），随后的 `if (session)` 恒为 false，超时文案永不生效。
 */
function teardownAuthProcess(): void {
  if (authTimer) {
    clearTimeout(authTimer)
    authTimer = null
  }
  stopPolling()
  submitPending = false
  if (proc && !proc.killed) {
    const pid = proc.pid
    // 同步等待 taskkill 完成：确保旧进程彻底退出后再 spawn 新的，
    // 否则两次认证会留下孤儿进程（都占 8080 / 状态错乱）
    try {
      const r = spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
        windowsHide: true,
        stdio: 'ignore',
      })
      if (r.status !== 0 && !proc.killed) {
        proc.kill() // taskkill 失败时退回普通 kill
      }
    } catch {
      proc.kill()
    }
  }
  proc = null
}

/**
 * 会话有效性巡检（auth-only 快速跑一次）：
 * 返回 true = cookie 有效；false = 会话过期/异常，需要重新链接。
 * 用于：启动时检查、同步前预检、定时巡检。
 * username 取库的 account（auth-only 需真实账号建立会话，有 cookie 时不要求密码）。
 * 注：此处仍用 console provider —— 有有效 cookie 时认证直接通过、无需输入；
 *     无 cookie 时会卡在密码提示，靠 30s 超时 kill 判定为无效（不会产生交互）。
 */
export function checkAuthValid(username: string, cookieDir: string): Promise<{ valid: boolean; message: string }> {
  return new Promise((resolve) => {
    if (!fs.existsSync(path.join(cookieDir))) {
      resolve({ valid: false, message: '无 cookie 目录，尚未认证' })
      return
    }
    const child = spawn(
      config.icloudpdExe,
      [
        '--username', username,
        '--password-provider', 'console',
        '--mfa-provider', 'console',
        '--cookie-directory', cookieDir,
        '--domain', 'cn',
        '--auth-only',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    )
    let out = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')))
    // 审查 P3f：超时用 taskkill /T 杀整个进程树（PyInstaller 有真实子进程，
    // 仅 child.kill() 会残留孤儿进程卡在密码提示等待输入）
    const timer = setTimeout(() => {
      try {
        if (child.pid) {
          spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
            windowsHide: true,
            stdio: 'ignore',
          })
        }
      } catch {
        child.kill()
      }
    }, 30_000)
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ valid: false, message: 'icloudpd 启动失败' })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0 && cookieExists(cookieDir)) {
        resolve({ valid: true, message: '会话有效' })
      } else {
        resolve({ valid: false, message: `会话无效（code=${code}）${/expired|invalid|401|失效/i.test(out) ? '：cookie 已过期' : ''}` })
      }
    })
  })
}
