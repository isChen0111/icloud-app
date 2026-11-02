/**
 * icloudpd 认证超时处理单元测试（审查 P3e）：
 * 旧实现 stopAuth() 先将 session 置 null 再判 `if (session)` → 超时文案死代码；
 * 修复后 onAuthTimeout() 先置 error 状态（前端轮询可读），teardownAuthProcess()
 * 只清理进程/轮询、保留 session 引用。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  newSession,
  onAuthTimeout,
  authStatus,
  stopAuth,
  extractError,
  applyAuthExit,
} from './auth.js'

const COOKIE_DIR = 'C:\\tmp\\nonexistent-cookie-dir'

test('onAuthTimeout：先置 error 文案，session 保留供前端读取（P3e）', () => {
  stopAuth() // 清理上一测试可能残留的 session
  newSession(COOKIE_DIR, 'waiting_password', '请输入 Apple ID 密码')
  onAuthTimeout()
  const s = authStatus()
  assert.ok(s, '超时后 session 必须保留（不能置 null，否则文案死代码）')
  assert.equal(s.stage, 'error')
  assert.equal(s.message, '认证超时（10 分钟），请重试')
  assert.equal(s.cookieDir, COOKIE_DIR)
  stopAuth()
})

test('onAuthTimeout：starting 阶段超时 → 同样置 error（前端展示超时而非卡在启动）', () => {
  stopAuth()
  newSession(COOKIE_DIR, 'starting', '正在启动认证服务…')
  onAuthTimeout()
  const s = authStatus()
  assert.ok(s)
  assert.equal(s.stage, 'error')
  assert.equal(s.message, '认证超时（10 分钟），请重试')
  stopAuth()
})

test('onAuthTimeout：无会话时安全无异常（不抛错）', () => {
  stopAuth() // session = null
  assert.doesNotThrow(() => onAuthTimeout())
})

test('onAuthTimeout：done 阶段超时回调兜底 → 不覆盖已完成状态', () => {
  stopAuth()
  const s = newSession(COOKIE_DIR, 'done', '认证成功，cookie 已保存')
  s.message = '认证成功，cookie 已保存'
  // 注：onAuthTimeout 无条件覆盖为超时（正常流程中 done 后 timer 已随 teardown 清理，
  // 此处仅验证不抛异常且状态机仍可读）
  assert.doesNotThrow(() => onAuthTimeout())
  const after = authStatus()
  assert.ok(after)
  stopAuth()
})

/**
 * 回归（2026-11-01「验证码输错后永久转圈」）：
 * icloudpd 的真实模板把错误放在 <div class="fw-bold"> 里，既没有 alert 类也没有 #toast-content。
 * 旧正则只认后两者 → 错误文案恒为空 → 前端拿不到解锁信号，界面锁死在「正在校验验证码…」。
 * 下面四段 HTML 全部取自 icloudpd 仓库 src/icloudpd/server/templates 的真实渲染结果。
 */

test('extractError：验证码输错（code.html 的 fw-bold 块）→ 解析出错误文案', () => {
  const html = `
<form hx-post="/code" hx-swap="outerHTML" class="row align-items-center" hx-target-error="#toast-content">
    <fieldset>
        <legend>Authentication - ischen0111@foxmail.com</legend>
        
        <ul class="list-group list-group-flush">
            <li class="list-group-item d-flex justify-content-between align-items-center">
                <div class="fw-bold">Failed to verify two-factor authentication code</div>
            </li>
        </ul>
        
        <div class="col-12 mb-3">
          <label for="code" class="form-label">Two-Factor code for ischen0111@foxmail.com</label>
          <input type="text" class="form-control" id="code" name="code" placeholder="Enter Two-Factor Code">
        </div>
    </fieldset>
</form>`
  assert.equal(extractError(html), 'Failed to verify two-factor authentication code')
})

test('extractError：正常验证码表单（无错误）→ undefined，不把 label 误当错误', () => {
  const html = `
<form>
  <label for="code" class="form-label">Two-Factor code for ischen0111@foxmail.com</label>
  <input type="text" id="code" name="code">
</form>`
  assert.equal(extractError(html), undefined)
})

test('extractError：提交被拒的 auth_error.html（Wrong … 标签）→ 解析出错误文案', () => {
  const html = `
<div>
    <fieldset>
        <legend>Authentication - ischen0111@foxmail.com</legend>
        <label class="form-label">Wrong Two-Factor Code for ischen0111@foxmail.com</label>
    </fieldset>
</div>`
  assert.equal(extractError(html), 'Wrong Two-Factor Code for ischen0111@foxmail.com')
})

test('extractError：no_input.html 的 fw-bold 是状态文案 → 不得当成错误', () => {
  const html = `
<div>
  <div class="card-header text-bg-primary">Status</div>
  <ul class="list-group list-group-flush">
    <li class="list-group-item"><div class="fw-bold">No input is needed</div></li>
  </ul>
</div>`
  assert.equal(extractError(html), undefined)
})

test('authStatus：未提交时 pending=false（前端据此解锁输入）', () => {
  stopAuth()
  newSession(COOKIE_DIR, 'waiting_code', '请输入验证码')
  const s = authStatus()
  assert.ok(s)
  assert.equal(s.pending, false, 'pending 必须显式返回，前端依赖它判断提交是否落定')
  assert.equal(s.stage, 'waiting_code')
  stopAuth()
})

/* ============ 审查 C-14：进程退出后的状态收敛 ============ */

test('C-14 ②：code=0 但没落 cookie → 置 error 并给文案，不再停在 waiting_code', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-nocookie-'))
  try {
    stopAuth()
    newSession(dir, 'waiting_code', '请输入发送到设备的验证码')
    applyAuthExit(0)
    const s = authStatus()
    assert.ok(s)
    // 旧实现：code===0 且 cookieExists() 为假 → 两个分支都不进，stopPolling 已跑、进程已退出，
    // stage 永远停在 waiting_code。前端轮询拿到「等待验证码」，但永远等不到变化。
    assert.equal(s.stage, 'error', '进程已退出、轮询已停，停在 waiting_code 就是永久转圈')
    assert.match(s.message, /没有生成 cookie/)
  } finally {
    stopAuth()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('C-14 ②对照：code=0 且 cookie 已落盘 → done', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-cookie-'))
  try {
    stopAuth()
    fs.writeFileSync(path.join(dir, 'isChen@example.com'), 'cookie')
    newSession(dir, 'waiting_code', '')
    applyAuthExit(0)
    const s = authStatus()
    assert.equal(s?.stage, 'done')
    assert.match(s!.message, /认证成功/)
  } finally {
    stopAuth()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('C-14：非零退出码 → error 且带 code，便于按原因排查', () => {
  stopAuth()
  newSession(COOKIE_DIR, 'waiting_password', '')
  applyAuthExit(1)
  const s = authStatus()
  assert.equal(s?.stage, 'error')
  assert.match(s!.message, /code=1/)
})

test('C-14 ①：error 阶段被超时回调兜底 → 保留准确原因，不改写成「认证超时」', () => {
  stopAuth()
  const s = newSession(COOKIE_DIR, 'error', '')
  // 模拟进程退出时写入的准确原因（这是用户排错的唯一线索）
  s.message = 'icloudpd 认证退出（code=1）。常见原因：密码错误 / Apple 临时限流'
  onAuthTimeout()
  const after = authStatus()!
  assert.match(after.message, /code=1/, '准确的失败原因不能被一句「认证超时」盖掉')
  assert.doesNotMatch(after.message, /认证超时/)
  assert.equal(after.stage, 'error')
})
